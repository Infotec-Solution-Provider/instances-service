import { plainToInstance } from "class-transformer";
import { prisma } from "../database/prisma.service";
import { ServerDto } from "./dto/create-server.dto";

class ServersService {
    public static async upsert(clientName: string, data: ServerDto): Promise<ServerDto> {
        const server = await prisma.server.upsert({
            create: { ...data, client_name: clientName },
            update: { ...data },
            where: {
                client_name: clientName
            }
        });

        return plainToInstance(ServerDto, server);
    }

    public static async get(clientName: string): Promise<ServerDto> {
        const server = await prisma.server.findFirst({
            where: {
                client_name: clientName
            }
        });

        return plainToInstance(ServerDto, server);
    }
}

export default ServersService;