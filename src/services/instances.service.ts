import { prisma } from "./prisma.service";
import { ConflictError } from "@rgranatodutra/http-errors";
import { CreateInstanceDto } from "../dtos/create-instance.dto";
import { plainToInstance } from "class-transformer";
import ServersService from "./servers.service";
import ParametersService from "./parameters.service";

class InstancesService {
  public static async create(
    data: CreateInstanceDto
  ): Promise<CreateInstanceDto> {
    const findDuplicated = await this.findByName(data.name);

    if (findDuplicated) {
      throw new ConflictError("client already exists");
    }

    const instance = await prisma.client.create({ data: { name: data.name } });
    const server = data.server
      ? await ServersService.upsert(instance.name, data.server)
      : null;
    const parameters = data.parameters
      ? await ParametersService.upsert(instance.name, data.parameters)
      : null;

    return plainToInstance(CreateInstanceDto, {
      ...instance,
      server,
      parameters,
    });
  }

  public static async findByName(name: string) {
    const findInstance = await prisma.client.findUnique({
      where: { name },
      include: {
        server: true,
        parameters: true,
      },
    });

    return findInstance;
  }

  public static async list() {
    const instances = await prisma.client.findMany({
      include: {
        server: true,
        parameters: true,
      },
    });

    return instances;
  }
}

export default InstancesService;
