import { createPool } from "mysql2";
import { NotFoundError } from "@rgranatodutra/http-errors";
import ClientPool from "../entities/client-pool.entity";
import ServersService from "./servers.service";

class PoolsService {
	private static readonly pools: Array<ClientPool> = [];

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
			});

			const clientPool = new ClientPool(instanceName, pool);

			PoolsService.pools.push(clientPool);

			return clientPool;
		}

		return findPool;
	}

	public static async query(
		instanceName: string,
		query: string,
		parameters: unknown,
	) {
		const pool = await PoolsService.getOrCreatePool(instanceName);

		const result = await pool.query(query, parameters);

		return result;
	}
}

export default PoolsService;
