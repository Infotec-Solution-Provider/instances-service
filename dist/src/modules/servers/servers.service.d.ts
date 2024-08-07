import { ServerDto } from "./dto/create-server.dto";
declare class ServersService {
    static upsert(clientName: string, data: ServerDto): Promise<ServerDto>;
    static get(clientName: string): Promise<ServerDto>;
}
export default ServersService;
