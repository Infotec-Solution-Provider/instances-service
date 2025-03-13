import { ServerDto } from "../dtos/create-server.dto";
import { prisma } from "./prisma.service";

class ServersService {
	public static async upsert(instanceName: string, data: ServerDto) {
		const server = await prisma.server.upsert({
			create: { ...data, instanceName },
			update: { ...data },
			where: {
				instanceName,
			},
		});

		return server;
	}

	public static async get(instanceName: string) {
		const server = await prisma.server.findFirst({
			where: {
				instanceName,
			},
		});

		return server;
	}
}

export default ServersService;
