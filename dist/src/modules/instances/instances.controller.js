"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const validateDto_1 = __importDefault(require("inpulse-crm/utils/src/validateDto"));
const create_instance_dto_1 = require("./dto/create-instance.dto");
const instances_service_1 = __importDefault(require("./instances.service"));
const http_errors_1 = require("@rgranatodutra/http-errors");
const auth_service_1 = __importDefault(require("../auth/auth.service"));
const pools_service_1 = __importDefault(require("../pools/pools.service"));
const axios_1 = __importDefault(require("axios"));
class InstancesController {
    constructor() {
        this.router = (0, express_1.Router)();
        this.router.post("/api/instances", auth_service_1.default.validateTokenMiddleware, (0, validateDto_1.default)(create_instance_dto_1.CreateInstanceDto), this.create);
        this.router.get("/api/instances", auth_service_1.default.validateTokenMiddleware, this.list);
        this.router.get("/api/instances/:clientName", auth_service_1.default.validateTokenMiddleware, this.getOneByName);
        this.router.get("/api/instances/:clientName/schedules-routine", auth_service_1.default.validateTokenMiddleware, this.routine);
    }
    async routine(req, res) {
        const instance = await instances_service_1.default.findByName(req.params.clientName);
        const generatedSchedules = [];
        const oldSchedules = await pools_service_1.default.execute(instance.name, "SELECT * FROM w_atendimentos WHERE DATA_AGENDAMENTO IS NOT NULL AND AGUARDANDO_RETORNO = 'SIM'", []);
        console.log(oldSchedules);
        for (const oldSchedule of oldSchedules.result) {
            const originalTimestamp = new Date(oldSchedule.DATA_AGENDAMENTO).getTime();
            const ajustedTimestamp = originalTimestamp - (3 * 60 * 60 * 1000);
            const ajustedDate = new Date(ajustedTimestamp);
            await axios_1.default.post(`http://localhost:7002/api/wa-schedules/${instance.name}`, {
                scheduleDate: ajustedDate,
                whatsappId: oldSchedule.CODIGO_NUMERO,
                toUserId: oldSchedule.CODIGO_OPERADOR,
                byUserId: oldSchedule.CODIGO_OPERADOR,
                sectorId: oldSchedule.SETOR
            })
                .then((res) => generatedSchedules.push(res.data.data))
                .catch((err) => console.log(err?.response?.data?.message || err));
        }
        return res.status(201).json({ message: "successful migrated schedules", data: generatedSchedules });
    }
    async create(req, res) {
        const createdInstance = await instances_service_1.default.create(req.body);
        return res.status(201).json({
            message: `successful created instance for ${createdInstance.name}`,
            data: createdInstance
        });
    }
    async list(_, res) {
        const allInstances = await instances_service_1.default.list();
        return res.status(200).json({
            message: "succesful listed instances",
            data: allInstances
        });
    }
    async getOneByName(req, res) {
        const { clientName } = req.params;
        const findInstance = await instances_service_1.default.findByName(clientName);
        if (!findInstance) {
            throw new http_errors_1.NotFoundError("instance not found");
        }
        return res.status(200).json({
            message: `succesful find ${clientName}'s instance`,
            data: findInstance
        });
    }
}
exports.default = InstancesController;
//# sourceMappingURL=instances.controller.js.map