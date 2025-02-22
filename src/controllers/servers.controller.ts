import { Request, Response, Router } from "express";
import * as core from "express-serve-static-core";
import validateDto from "inpulse-crm/utils/src/validateDto";
import { NotFoundError } from "@rgranatodutra/http-errors";
import AuthService from "../services/auth.service";
import { CreateServerDto } from "../dtos/create-server.dto";
import InstancesService from "../services/instances.service";
import ServersService from "../services/servers.service";

class ServersController {
  public readonly router: core.Router;

  constructor() {
    this.router = Router();

    this.router.put(
      "/api/instances/:clientName/server",
      AuthService.validateTokenMiddleware,
      validateDto(CreateServerDto),
      this.set
    );
  }

  private async set(req: Request, res: Response): Promise<Response> {
    const clientName = req.params["clientName"]!;
    const findClient = await InstancesService.findByName(clientName);

    if (!findClient) {
      throw new NotFoundError(`Instância "${clientName}" não encontrada.`);
    }

    const server = await ServersService.upsert(
      findClient.name,
      req.body.server
    );

    return res.status(201).json({
      message: `DB de ${clientName} definido com sucesso!`,
      data: server,
    });
  }
}

export default ServersController;
