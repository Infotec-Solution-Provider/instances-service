import { Pool, PoolConnection, QueryResult } from "mysql2";

class ClientPool {
	public readonly name: string;
	private pool: Pool;

	constructor(name: string, pool: Pool) {
		this.name = name;
		this.pool = pool;
	}

	public async query(query: string, parameters: unknown) {
		const queryResult = new Promise<QueryResult>((res, rej) => {
			this.pool.query(query, parameters, (err, result) => {
				if (err) {
					rej(err);
					return;
				}

				res(result);
			});
		});

		return queryResult;
	}

	/**
	 * Verifica se a conexão está ativa executando uma query simples
	 */
	public async ping(timeoutMs = 10000): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let connection: PoolConnection | undefined;
			let settled = false;
			const finish = (error?: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				if (error) {
					connection?.destroy();
					reject(error);
				} else {
					connection?.release();
					resolve();
				}
			};
			// Include time spent waiting for a free connection in the deadline.
			const timer = setTimeout(() => {
				finish(
					Object.assign(
						new Error(`Health check timeout for ${this.name}`),
						{
							code: connection
								? "POOL_HEALTH_CHECK_TIMEOUT"
								: "POOL_HEALTH_CHECK_BUSY",
						},
					),
				);
			}, timeoutMs);

			try {
				this.pool.getConnection((error, acquiredConnection) => {
					if (settled) {
						acquiredConnection?.release();
						return;
					}
					if (error) {
						finish(error);
						return;
					}
					connection = acquiredConnection;
					try {
						connection.query("SELECT 1", (queryError) => {
							finish(queryError ?? undefined);
						});
					} catch (queryError) {
						finish(queryError);
					}
				});
			} catch (error) {
				finish(error);
			}
		});
	}

	/**
	 * Destroi o pool de conexões adequadamente
	 */
	public async destroy(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.pool.end((err) => {
				if (err) {
					console.error(
						`Erro ao destruir pool ${this.name}:`,
						err.message,
					);
					reject(err);
				} else {
					console.log(`Pool ${this.name} destruído com sucesso.`);
					resolve();
				}
			});
		});
	}
}

export default ClientPool;
