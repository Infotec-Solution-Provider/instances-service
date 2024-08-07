declare class ParametersService {
    static upsert(clientName: string, data: Record<any, any>): Promise<Record<string, any>>;
}
export default ParametersService;
