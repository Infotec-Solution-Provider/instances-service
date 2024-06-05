import { Request, Response, Router } from "express";
import * as core from "express-serve-static-core";
import validateDto from "inpulse-crm/utils/src/validateDto";
import ServersService from "./servers.service";
import InstancesService from "../instances/instances.service";
import { NotFoundError } from "@rgranatodutra/http-errors";
import { CreateServerDto } from "./dto/create-server.dto";

class ServersController {
    public readonly router: core.Router;

    constructor() {
        this.router = Router();

        this.router.put("/api/instances/:clientName/server", validateDto(CreateServerDto), this.set);
    }

    private async set(req: Request, res: Response): Promise<Response> {
        const { clientName } = req.params;
        const findClient = await InstancesService.findByName(clientName);

        if (!findClient) {
            throw new NotFoundError(`client "${clientName}" not found`);
        }

        const server = await ServersService.upsert(findClient.name, req.body.server);

        return res.status(201).json({
            message: `successful defined database server for ${clientName}`,
            data: server
        });
    }
}

export default ServersController;