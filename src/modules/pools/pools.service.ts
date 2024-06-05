import { createPool } from "mysql2";
import ServersService from "../servers/servers.service";
import ClientPool from "./entity/client-pool.entity";
import { NotFoundError } from "@rgranatodutra/http-errors";

class PoolsService {
    private static readonly pools: Array<ClientPool> = [];

    private static async getOrCreatePool(clientName: string): Promise<ClientPool> {
        const findPool = PoolsService.pools.find((cp) => cp.name === clientName);

        if (!findPool) {
            const server = await ServersService.get(clientName);

            if (!server) {
                throw new NotFoundError(`${clientName}'s database not found`);
            }

            const { host, port, username: user, password, database } = server;

            const pool = createPool({
                host, port, user, password, database,
                maxPreparedStatements: 1000
            });

            const clientPool = new ClientPool(clientName, pool);

            PoolsService.pools.push(clientPool);

            return clientPool;
        }

        return findPool;
    }

    public static async execute(clientName: string, query: string, parameters: unknown) {
        const pool = await PoolsService.getOrCreatePool(clientName);

        return pool.execute(query, parameters);
    }
}

export default PoolsService;