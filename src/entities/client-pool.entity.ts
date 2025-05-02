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
}

export default ClientPool;
