import { createPool } from "mysql2";
import { NotFoundError } from "@rgranatodutra/http-errors";
import ClientPool from "../entities/client-pool.entity";
import ServersService from "./servers.service";

class PoolsService {
  private static readonly pools: Array<ClientPool> = [];

  private static async getOrCreatePool(clientName: string) {
    const findPool = PoolsService.pools.find((cp) => cp.name === clientName);

    if (!findPool) {
      const server = await ServersService.get(clientName);

      if (!server) {
        throw new NotFoundError(`Server de ${clientName} não encontrado.`);
      }

      const { host, port, username: user, password, database } = server;

      const pool = createPool({
        host,
        port,
        user,
        password,
        database,
        maxPreparedStatements: 1000,
      });

      const clientPool = new ClientPool(clientName, pool);

      PoolsService.pools.push(clientPool);

      return clientPool;
    }

    return findPool;
  }

  public static async query(clientName: string, query: string, parameters: unknown) {
    const pool = await PoolsService.getOrCreatePool(clientName);

    const result = await pool.query(query, parameters);

    return result;
  }
}

export default PoolsService;
