"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const class_transformer_1 = require("class-transformer");
const prisma_service_1 = require("../database/prisma.service");
const create_server_dto_1 = require("./dto/create-server.dto");
class ServersService {
    static async upsert(clientName, data) {
        const server = await prisma_service_1.prisma.server.upsert({
            create: { ...data, client_name: clientName },
            update: { ...data },
            where: {
                client_name: clientName
            }
        });
        return (0, class_transformer_1.plainToInstance)(create_server_dto_1.ServerDto, server);
    }
    static async get(clientName) {
        const server = await prisma_service_1.prisma.server.findFirst({
            where: {
                client_name: clientName
            }
        });
        return (0, class_transformer_1.plainToInstance)(create_server_dto_1.ServerDto, server);
    }
}
exports.default = ServersService;
//# sourceMappingURL=servers.service.js.map