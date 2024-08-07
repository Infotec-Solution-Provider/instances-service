"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const validateDto_1 = __importDefault(require("inpulse-crm/utils/src/validateDto"));
const servers_service_1 = __importDefault(require("./servers.service"));
const instances_service_1 = __importDefault(require("../instances/instances.service"));
const http_errors_1 = require("@rgranatodutra/http-errors");
const create_server_dto_1 = require("./dto/create-server.dto");
const auth_service_1 = __importDefault(require("../auth/auth.service"));
class ServersController {
    constructor() {
        this.router = (0, express_1.Router)();
        this.router.put("/api/instances/:clientName/server", auth_service_1.default.validateTokenMiddleware, (0, validateDto_1.default)(create_server_dto_1.CreateServerDto), this.set);
    }
    async set(req, res) {
        const { clientName } = req.params;
        const findClient = await instances_service_1.default.findByName(clientName);
        if (!findClient) {
            throw new http_errors_1.NotFoundError(`client "${clientName}" not found`);
        }
        const server = await servers_service_1.default.upsert(findClient.name, req.body.server);
        return res.status(201).json({
            message: `successful defined database server for ${clientName}`,
            data: server
        });
    }
}
exports.default = ServersController;
//# sourceMappingURL=servers.controller.js.map