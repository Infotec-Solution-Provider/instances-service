import { Request, Response, Router } from "express";
import * as core from "express-serve-static-core";
import validateDto from "inpulse-crm/utils/src/validateDto";
import { CreateInstanceDto } from "./dto/create-instance.dto";
import InstancesService from "./instances.service";
import { NotFoundError } from "@rgranatodutra/http-errors";
import AuthService from "../auth/auth.service";
import PoolsService from "../pools/pools.service";
import { RowDataPacket } from "mysql2";
import axios from "axios";

class InstancesController {
    public readonly router: core.Router;

    constructor() {
        this.router = Router();

        this.router.post("/api/instances", AuthService.validateTokenMiddleware, validateDto(CreateInstanceDto), this.create);
        this.router.get("/api/instances", AuthService.validateTokenMiddleware, this.list);
        this.router.get("/api/instances/:clientName", AuthService.validateTokenMiddleware, this.getOneByName);
        this.router.post("/api/instances/schedules-routine", AuthService.validateTokenMiddleware, this.routine)
    }

    private async routine(req: Request, res: Response): Promise<Response> {
        const allInstances = await InstancesService.list();
        const generatedSchedules: any[] = [];

        for (const instance of allInstances) {
            const oldSchedules = await PoolsService.execute(
                instance.name,
                "SELECT * FROM w_atendimentos WHERE DATA_AGENDAMENTO IS NOT NULL AND AGUARDANDO_RETORNO = 'SIM'",
                []
            );

            if (!Array.isArray(oldSchedules)) {
                continue;
            }

            for (const oldSchedule of oldSchedules as unknown as RowDataPacket[]) {
                const originalTimestamp = new Date(oldSchedule.DATA_AGENDAMENTO).getTime();
                const ajustedTimestamp = originalTimestamp - (3 * 60 * 60 * 1000);
                const ajustedDate = new Date(ajustedTimestamp);

                await axios.post(`http://localhost:7002/api/wa-schedules/${instance.name}`, {
                    scheduleDate: ajustedDate,
                    whatsappId: oldSchedule.CODIGO_NUMERO,
                    toUserId: oldSchedule.CODIGO_OPERADOR,
                    byUserId: oldSchedule.CODIGO_OPERADOR,
                    sectorId: oldSchedule.SETOR
                })
                    .then((res) => generatedSchedules.push(res.data.data))
                    .catch((err) => console.log(err?.response?.data?.message || err));
            }
        }
        return res.status(201).json({ message: "successful migrated schedules", data: generatedSchedules })

    }

    private async create(req: Request, res: Response): Promise<Response> {
        const createdInstance = await InstancesService.create(req.body);

        return res.status(201).json({
            message: `successful created instance for ${createdInstance.name}`,
            data: createdInstance
        });
    }

    private async list(_: Request, res: Response): Promise<Response> {
        const allInstances = await InstancesService.list();

        return res.status(200).json({
            message: "succesful listed instances",
            data: allInstances
        });
    }

    private async getOneByName(req: Request, res: Response): Promise<Response> {
        const { clientName } = req.params;

        const findInstance = await InstancesService.findByName(clientName);

        if (!findInstance) {
            throw new NotFoundError("instance not found");
        }

        return res.status(200).json({
            message: `succesful find ${clientName}'s instance`,
            data: findInstance
        });
    }
}

export default InstancesController;