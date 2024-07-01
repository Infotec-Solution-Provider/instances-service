import { Request, Response, Router } from "express";
import * as core from "express-serve-static-core";
import validateDto from "inpulse-crm/utils/src/validateDto";
import { CreateInstanceDto } from "./dto/create-instance.dto";
import InstancesService from "./instances.service";
import { NotFoundError } from "@rgranatodutra/http-errors";
import AuthService from "../auth/auth.service";

class InstancesController {
    public readonly router: core.Router;

    constructor() {
        this.router = Router();

        this.router.post("/api/instances", AuthService.validateTokenMiddleware, validateDto(CreateInstanceDto), this.create);
        this.router.get("/api/instances", AuthService.validateTokenMiddleware, this.list);
        this.router.get("/api/instances/:clientName", AuthService.validateTokenMiddleware, this.getOneByName);
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