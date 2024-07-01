import { Request, Response, Router } from "express";
import * as core from "express-serve-static-core";
import validateDto from "inpulse-crm/utils/src/validateDto";
import InstancesService from "../instances/instances.service";
import { NotFoundError } from "@rgranatodutra/http-errors";
import { CreateParametersDto } from "./dto/create-parameter.dto";
import ParametersService from "./parameters.service";
import AuthService from "../auth/auth.service";

class ParametersController {
    public readonly router: core.Router;

    constructor() {
        this.router = Router();

        this.router.put("/api/instances/:clientName/parameters", AuthService.validateTokenMiddleware, validateDto(CreateParametersDto), this.set);
    }

    private async set(req: Request, res: Response): Promise<Response> {
        const { clientName } = req.params;
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