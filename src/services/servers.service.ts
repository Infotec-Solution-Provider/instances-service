import { plainToInstance } from "class-transformer";
import { ServerDto } from "../dtos/create-server.dto";
import { prisma } from "./prisma.service";

class ServersService {
  public static async upsert(clientName: string, data: ServerDto) {
    const server = await prisma.server.upsert({
      create: { ...data, client_name: clientName },
      update: { ...data },
      where: {
        client_name: clientName,
      },
    });

    return server;
  }

  public static async get(clientName: string) {
    const server = await prisma.server.findFirst({
      where: {
        client_name: clientName,
      },
    });

    return server;
  }
}

export default ServersService;
