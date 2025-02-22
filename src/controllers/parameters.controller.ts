import { Request, Response, Router } from "express";
import * as core from "express-serve-static-core";
import validateDto from "inpulse-crm/utils/src/validateDto";
import { NotFoundError } from "@rgranatodutra/http-errors";
import AuthService from "../services/auth.service";
import { CreateParametersDto } from "../dtos/create-parameter.dto";
import InstancesService from "../services/instances.service";
import ParametersService from "../services/parameters.service";


class ParametersController {
    public readonly router: core.Router;

    constructor() {
        this.router = Router();

        this.router.put("/api/instances/:clientName/parameters", AuthService.validateTokenMiddleware, validateDto(CreateParametersDto), this.set);
    }

    private async set(req: Request, res: Response): Promise<Response> {
        const clientName = req.params["clientName"]!;	
        const findClient = await InstancesService.findByName(clientName);

        if (!findClient) {
            throw new NotFoundError(`client "${clientName}" not found`);
        }

        const parameters = await ParametersService.upsert(findClient.name, req.body.parameters);

        return res.status(201).json({
            message: `successful defined parameters for ${clientName}`,
            data: parameters
        });
    }
}

export default ParametersController;