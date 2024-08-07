import { Pool } from "mysql2";
import { CustomQueryResult } from "../types/query-result.type";
declare class ClientPool {
    readonly name: string;
    private pool;
    constructor(name: string, pool: Pool);
    execute(query: string, parameters: unknown): Promise<CustomQueryResult>;
}
export default ClientPool;
