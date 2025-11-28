import { createPool } from "mysql2";
import { NotFoundError } from "@rgranatodutra/http-errors";
import ClientPool from "../entities/client-pool.entity";
import ServersService from "./servers.service";

class PoolsService {
	private static readonly pools: Array<ClientPool> = [];
	private static readonly poolHealthCheckInterval = 30000; // 30 segundos

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
		const index = PoolsService.pools.findIndex(
			(cp) => cp.name === instanceName,
		);

		if (index !== -1) {
			const pool = PoolsService.pools[index];
			if (pool) {
				await pool.destroy();
			}
			PoolsService.pools.splice(index, 1);
			console.log(`Pool ${instanceName} removido e destruído.`);
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
				connectTimeout: 10000, // 10 segundos
				waitForConnections: true,
				queueLimit: 0,
				enableKeepAlive: true,
				keepAliveInitialDelay: 0,
			});

			// Listener para erros de conexão
			pool.on("error", (err: any) => {
				console.error(
					`Erro no pool ${instanceName}:`,
					err.message,
				);
				if (err.code === "PROTOCOL_CONNECTION_LOST" || 
				    err.code === "ECONNRESET" || 
				    err.code === "ETIMEDOUT") {
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

				// Se for erro de conexão, remover o pool e tentar novamente
				if (
					err.code === "PROTOCOL_CONNECTION_LOST" ||
					err.code === "ECONNRESET" ||
					err.code === "ETIMEDOUT" ||
					err.code === "ENOTFOUND" ||
					err.errno === "ECONNREFUSED"
				) {
					await PoolsService.removePool(instanceName);

					if (attempt < maxRetries) {
						// Aguardar antes de tentar novamente (exponential backoff)
						const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
						console.log(
							`Aguardando ${delay}ms antes de tentar reconectar...`,
						);
						await new Promise((resolve) => setTimeout(resolve, delay));
						continue;
					}
				}

				// Para outros erros, falhar imediatamente
				throw err;
			}
		}

		throw lastError;
	}
}

export default PoolsService;
