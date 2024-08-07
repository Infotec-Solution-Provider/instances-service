declare class PoolsService {
    private static readonly pools;
    private static getOrCreatePool;
    static execute(clientName: string, query: string, parameters: unknown): Promise<import("./types/query-result.type").CustomQueryResult>;
}
export default PoolsService;
