import { Request, Response, Router } from "express";
import * as core from "express-serve-static-core";
import validateDto from "inpulse-crm/utils/src/validateDto";
import { CreateInstanceDto } from "../dtos/create-instance.dto";
import InstancesService from "../services/instances.service";
import { NotFoundError } from "@rgranatodutra/http-errors";
import AuthService from "../services/auth.service";

class InstancesController {
  public readonly router: core.Router;

  constructor() {
    this.router = Router();

    this.router.post(
      "/api/instances",
      AuthService.validateTokenMiddleware,
      validateDto(CreateInstanceDto),
      this.create
    );
    this.router.get(
      "/api/instances",
      AuthService.validateTokenMiddleware,
      this.list
    );
    this.router.get(
      "/api/instances/:clientName",
      AuthService.validateTokenMiddleware,
      this.getOneByName
    );
  }

  private async create(req: Request, res: Response): Promise<Response> {
    const createdInstance = await InstancesService.create(req.body);

    return res.status(201).json({
      message: `Instância "${createdInstance.name}" criada com sucesso!`,
      data: createdInstance,
    });
  }

  private async list(_: Request, res: Response): Promise<Response> {
    const allInstances = await InstancesService.list();

    return res.status(200).json({
      message: "Instâncias listadas com sucesso!",
      data: allInstances,
    });
  }

  private async getOneByName(req: Request, res: Response): Promise<Response> {
    const findInstance = await InstancesService.findByName(
      req.params["clientName"]!
    );

    if (!findInstance) {
      throw new NotFoundError("Instância não encontrada.");
    }

    return res.status(200).json({
      message: `Instância "${findInstance.name}" encontrada com sucesso!`,
      data: findInstance,
    });
  }
}

export default InstancesController;
