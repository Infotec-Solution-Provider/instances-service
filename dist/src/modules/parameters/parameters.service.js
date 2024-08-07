"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_service_1 = require("../database/prisma.service");
class ParametersService {
    static async upsert(clientName, data) {
        const { parameters } = await prisma_service_1.prisma.parameters.upsert({
            create: {
                client_name: clientName,
                parameters: data,
            },
            update: {
                parameters: data,
            },
            where: { client_name: clientName }
        });
        return parameters;
    }
}
exports.default = ParametersService;
//# sourceMappingURL=parameters.service.js.map