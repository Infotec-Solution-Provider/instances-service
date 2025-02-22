import { Pool } from "mysql2";
import { CustomQueryResult } from "../types/query-result.type";

class ClientPool {
  public readonly name: string;
  private pool: Pool;

  constructor(name: string, pool: Pool) {
    this.name = name;
    this.pool = pool;
  }

  public async query(query: string, parameters: unknown) {
    const queryResult = new Promise<CustomQueryResult>(async (res) => {
      this.pool.query(query, parameters, (err, result) => {
        if (err) {
          res({ err });
        }

        res({ result });
      });
    });

    return queryResult;
  }
}

export default ClientPool;
