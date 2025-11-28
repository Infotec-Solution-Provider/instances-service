import { Pool, QueryResult } from "mysql2";

class ClientPool {
	public readonly name: string;
	private pool: Pool;

	constructor(name: string, pool: Pool) {
		this.name = name;
		this.pool = pool;
	}

	public async query(query: string, parameters: unknown) {
		const queryResult = new Promise<QueryResult>(async (res, rej) => {
			this.pool.query(query, parameters, (err, result) => {
				if (err) {
					rej(err);
				}

				res(result);
			});
		});

		return queryResult;
	}

	/**
	 * Verifica se a conexão está ativa executando uma query simples
	 */
	public async ping(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.pool.query("SELECT 1", (err) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
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
