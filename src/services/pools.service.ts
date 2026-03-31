import { createPool } from "mysql2";
import { NotFoundError } from "@rgranatodutra/http-errors";
import ClientPool from "../entities/client-pool.entity";
import ServersService from "./servers.service";

class PoolsService {
	private static readonly pools: Array<ClientPool> = [];
	private static readonly poolHealthCheckInterval = 30000; // 30 segundos
	private static readonly destroyingPools = new Set<string>();

	private static setupPoolHealthCheck() {
		setInterval(() => {
			PoolsService.pools.forEach(async (clientPool) => {
				try {
					await clientPool.ping();
				} catch (error) {
					console.error(
						`Health check falhou para pool ${clientPool.name}. Recriando pool...`,
						error,
					);
					await PoolsService.removePool(clientPool.name);
				}
			});
		}, PoolsService.poolHealthCheckInterval);
	}

	private static async removePool(instanceName: string) {
		// Guard against concurrent destruction of the same pool
		if (PoolsService.destroyingPools.has(instanceName)) {
			return;
		}

		const index = PoolsService.pools.findIndex(
			(cp) => cp.name === instanceName,
		);

		if (index === -1) {
			return;
		}

		PoolsService.destroyingPools.add(instanceName);

		const [pool] = PoolsService.pools.splice(index, 1);

		try {
			if (pool) {
				await pool.destroy();
			}
			console.log(`Pool ${instanceName} removido e destruído.`);
		} catch (err: any) {
			console.error(`Erro ao destruir pool ${instanceName}:`, err.message);
		} finally {
			PoolsService.destroyingPools.delete(instanceName);
		}
	}

	private static async getOrCreatePool(instanceName: string) {
		const findPool = PoolsService.pools.find(
			(cp) => cp.name === instanceName,
		);

		if (!findPool) {
			const server = await ServersService.get(instanceName);

			if (!server) {
				throw new NotFoundError(
					`Server de ${instanceName} não encontrado.`,
				);
			}

			const { host, port, username: user, password, database } = server;

			const pool = createPool({
				host,
				port,
				user,
				password,
				database,
				maxPreparedStatements: 1000,
				charset: "latin1_swedish_ci",
				// Configurações de resiliência
				connectionLimit: 10,
				connectTimeout: 60000, // 10 segundos
				waitForConnections: true,
				queueLimit: 0,
				enableKeepAlive: true,
				keepAliveInitialDelay: 0,
			});

			// Listener para erros fatais de protocolo (conexão irrecuperável)
			// ETIMEDOUT em conexões individuais não destrói o pool — o health check cuida disso
			pool.on("error", (err: any) => {
				console.error(
					`Erro no pool ${instanceName}:`,
					err.message,
				);
				if (err.code === "PROTOCOL_CONNECTION_LOST") {
					console.log(
						`Conexão perdida para ${instanceName}. Pool será recriado na próxima query.`,
					);
					PoolsService.removePool(instanceName);
				}
			});

			const clientPool = new ClientPool(instanceName, pool);

			PoolsService.pools.push(clientPool);

			// Iniciar health check no primeiro pool criado
			if (PoolsService.pools.length === 1) {
				PoolsService.setupPoolHealthCheck();
			}

			return clientPool;
		}

		return findPool;
	}

	public static async query(
		instanceName: string,
		query: string,
		parameters: unknown,
	) {
		const maxRetries = 3;
		let lastError: any;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				const pool = await PoolsService.getOrCreatePool(instanceName);
				const result = await pool.query(query, parameters);

				return result;
			} catch (err: any) {
				lastError = err;
				console.error(
					`Erro na tentativa ${attempt}/${maxRetries} para ${instanceName}:`,
					err.message,
				);

				// Só destrói o pool em erros fatais de protocolo (estado irrecuperável).
				// ETIMEDOUT/ECONNRESET em conexões individuais são gerenciados pelo próprio
				// mysql2 — destruir o pool causaria falha em todas as queries paralelas.
				if (err.code === "PROTOCOL_CONNECTION_LOST") {
					await PoolsService.removePool(instanceName);

					if (attempt < maxRetries) {
						const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
						console.log(`Aguardando ${delay}ms antes de tentar reconectar...`);
						await new Promise((resolve) => setTimeout(resolve, delay));
						continue;
					}
				}

				// Para todos os outros erros (incluindo ETIMEDOUT), falha imediatamente.
				// O health check a cada 30s remove o pool se o servidor estiver inacessível.
				throw err;
			}
		}

		throw lastError;
	}
}

export default PoolsService;
