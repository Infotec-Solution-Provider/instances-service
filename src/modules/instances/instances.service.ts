import { prisma } from "../database/prisma.service";
import { ConflictError } from "@rgranatodutra/http-errors";
import { CreateInstanceDto } from "./dto/create-instance.dto";
import ServersService from "../servers/servers.service";
import ParametersService from "../parameters/parameters.service";
import { plainToInstance } from "class-transformer";

class InstancesService {
    public static async create(data: CreateInstanceDto): Promise<CreateInstanceDto> {
        const findDuplicated = await this.findByName(data.name);

        if (findDuplicated) {
            throw new ConflictError("client already exists");
        }

        const instance = await prisma.client.create({ data: { name: data.name } });
        const server = data.server ? await ServersService.upsert(instance.name, data.server) : null;
        const parameters = data.parameters ? await ParametersService.upsert(instance.name, data.parameters) : null;

        return plainToInstance(
            CreateInstanceDto,
            { ...instance, server, parameters }
        );
    }

    public static async findByName(name: string): Promise<CreateInstanceDto> {
        const findInstance = await prisma.client.findUnique({
            where: { name },
            include: {
                server: true,
                parameters: true
            }
        });

        if (findInstance) {
            return plainToInstance(CreateInstanceDto, findInstance);
        }

        return null;
    }

    public static async list(): Promise<Array<CreateInstanceDto>> {
        const instances = await prisma.client.findMany({
            include: {
                server: true,
                parameters: true,
            }
        });

        const formatedInstancesArr = instances.map((instance) => {
            return plainToInstance(CreateInstanceDto, instance);
        });

        return formatedInstancesArr;
    }
}

export default InstancesService;