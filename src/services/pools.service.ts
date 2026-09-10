import { createPool } from "mysql2";
import { NotFoundError } from "@rgranatodutra/http-errors";
import ClientPool from "../entities/client-pool.entity";
import ServersService from "./servers.service";

class PoolsService {
	private static readonly pools: Array<ClientPool> = [];
	private static readonly poolHealthCheckInterval = 30000; // 30 segundos
	private static readonly creatingPools = new Map<
		string,
		Promise<ClientPool>
	>();
	private static healthCheckTimer: NodeJS.Timeout | undefined;
	private static healthCheckRunning = false;

	private static setupPoolHealthCheck() {
		if (PoolsService.healthCheckTimer) {
			return;
		}
		PoolsService.healthCheckTimer = setInterval(() => {
			void PoolsService.checkPoolsHealth();
		}, PoolsService.poolHealthCheckInterval);
		PoolsService.healthCheckTimer.unref();
	}

	private static async checkPoolsHealth() {
		if (PoolsService.healthCheckRunning) {
			return;
		}
		PoolsService.healthCheckRunning = true;
		try {
			await Promise.all(
				[...PoolsService.pools].map(async (clientPool) => {
					try {
						await clientPool.ping();
					} catch (error) {
						if (
							error &&
							typeof error === "object" &&
							"code" in error &&
							error.code === "POOL_HEALTH_CHECK_BUSY"
						) {
							console.warn(
								`Health check sem conexão disponível para ${clientPool.name}; aguardando próxima verificação.`,
							);
							return;
						}
						console.error(
							`Health check falhou para pool ${clientPool.name}. Recriando pool...`,
							error,
						);
						PoolsService.removePool(clientPool);
					}
				}),
			);
		} finally {
			PoolsService.healthCheckRunning = false;
		}
	}

	private static removePool(pool: ClientPool) {
		// A late error from an old pool must not remove its replacement.
		const index = PoolsService.pools.indexOf(pool);

		if (index === -1) {
			return;
		}

		PoolsService.pools.splice(index, 1);
		// mysql2.end() may wait for an in-flight command indefinitely. Detach
		// cleanup so an old socket cannot block creation or removal of new pools.
		void pool
			.destroy()
			.then(() => {
				console.log(`Pool ${pool.name} removido e destruído.`);
			})
			.catch((err: unknown) => {
				console.error(`Erro ao destruir pool ${pool.name}:`, err);
			});
	}

	private static async getOrCreatePool(instanceName: string) {
		const findPool = PoolsService.pools.find(
			(cp) => cp.name === instanceName,
		);

		if (findPool) {
			return findPool;
		}
		const pendingPool = PoolsService.creatingPools.get(instanceName);
		if (pendingPool) {
			return pendingPool;
		}
		const creation = PoolsService.createClientPool(instanceName);
		PoolsService.creatingPools.set(instanceName, creation);
		try {
			return await creation;
		} finally {
			PoolsService.creatingPools.delete(instanceName);
		}
	}

	private static async createClientPool(instanceName: string) {
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
			connectTimeout: 60000, // 60 segundos
			waitForConnections: true,
			queueLimit: 0,
			enableKeepAlive: true,
			keepAliveInitialDelay: 0,
		});

		const clientPool = new ClientPool(instanceName, pool);

		// Listener para erros fatais de protocolo (conexão irrecuperável)
		// ETIMEDOUT em conexões individuais não destrói o pool — o health check cuida disso
		pool.on("error", (err: any) => {
			console.error(`Erro no pool ${instanceName}:`, err.message);
			if (err.code === "PROTOCOL_CONNECTION_LOST") {
				console.log(
					`Conexão perdida para ${instanceName}. Pool será recriado na próxima query.`,
				);
				PoolsService.removePool(clientPool);
			}
		});

		PoolsService.pools.push(clientPool);

		PoolsService.setupPoolHealthCheck();

		return clientPool;
	}

	public static async query(
		instanceName: string,
		query: string,
		parameters: unknown,
	) {
		const maxRetries = 3;
		let lastError: any;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			let pool: ClientPool | undefined;
			try {
				pool = await PoolsService.getOrCreatePool(instanceName);
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
				if (err.code === "PROTOCOL_CONNECTION_LOST" && pool) {
					PoolsService.removePool(pool);

					if (attempt < maxRetries) {
						const delay = Math.min(
							1000 * Math.pow(2, attempt - 1),
							5000,
						);
						console.log(
							`Aguardando ${delay}ms antes de tentar reconectar...`,
						);
						await new Promise((resolve) =>
							setTimeout(resolve, delay),
						);
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
