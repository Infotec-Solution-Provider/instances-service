"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_service_1 = require("../database/prisma.service");
const http_errors_1 = require("@rgranatodutra/http-errors");
const create_instance_dto_1 = require("./dto/create-instance.dto");
const servers_service_1 = __importDefault(require("../servers/servers.service"));
const parameters_service_1 = __importDefault(require("../parameters/parameters.service"));
const class_transformer_1 = require("class-transformer");
class InstancesService {
    static async create(data) {
        const findDuplicated = await this.findByName(data.name);
        if (findDuplicated) {
            throw new http_errors_1.ConflictError("client already exists");
        }
        const instance = await prisma_service_1.prisma.client.create({ data: { name: data.name } });
        const server = data.server ? await servers_service_1.default.upsert(instance.name, data.server) : null;
        const parameters = data.parameters ? await parameters_service_1.default.upsert(instance.name, data.parameters) : null;
        return (0, class_transformer_1.plainToInstance)(create_instance_dto_1.CreateInstanceDto, { ...instance, server, parameters });
    }
    static async findByName(name) {
        const findInstance = await prisma_service_1.prisma.client.findUnique({
            where: { name },
            include: {
                server: true,
                parameters: true
            }
        });
        if (findInstance) {
            return (0, class_transformer_1.plainToInstance)(create_instance_dto_1.CreateInstanceDto, findInstance);
        }
        return null;
    }
    static async list() {
        const instances = await prisma_service_1.prisma.client.findMany({
            include: {
                server: true,
                parameters: true,
            }
        });
        const formatedInstancesArr = instances.map((instance) => {
            return (0, class_transformer_1.plainToInstance)(create_instance_dto_1.CreateInstanceDto, instance);
        });
        return formatedInstancesArr;
    }
}
exports.default = InstancesService;
//# sourceMappingURL=instances.service.js.map