import { Pool } from "mysql2";
import { CustomQueryResult } from "../types/query-result.type";
import { BadRequestError, NotFoundError } from "@rgranatodutra/http-errors";

class ClientPool {
    public readonly name: string;
    private pool: Pool;

    constructor(name: string, pool: Pool) {
        this.name = name;
        this.pool = pool;
    }

    public async execute(query: string, parameters: unknown): Promise<CustomQueryResult> {
        return new Promise(async (resolve, reject) => {
            const havePool = await new Promise<boolean>((res) => {
                const validatePool = (tries: number = 0) => {
                    if (tries >= 3) res(false)
                    else if (this.pool) res(true)
                    else {
                        setTimeout(() => {
                            validatePool(tries++);
                        }, 1000);
                    }
                }

                validatePool();
            });

            if (!havePool) {
                reject(new NotFoundError("failed to get client's pool"));
            }

            this.pool.query(query, parameters, (err, result) => {
                if (err) {
                    reject(new BadRequestError("failed to execute query", err));
                }

                resolve({ result });
            });
        });
    }
}

export default ClientPool;