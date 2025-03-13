import { Request, Response, Router } from "express";
import * as core from "express-serve-static-core";
import "dotenv/config";
import PoolsService from "../services/pools.service";
import validateDto from "inpulse-crm/utils/src/validateDto";
import { QueryDto } from "../dtos/query.dto";

class PoolsController {
  public readonly router: core.Router;

  constructor() {
    this.router = Router();

    this.router.post(
      "/api/instances/:clientName/query",
      validateDto(QueryDto),
      this.executeQuery
    );
  }

  private async executeQuery(req: Request, res: Response): Promise<Response> {
    const { query, parameters } = req.body as QueryDto;

    const data = await PoolsService.query(
      req.params["clientName"]!,
      query,
      parameters
    );

    if("err" in data) {
      return res.status(400).json({
        message: "Failed to execute query!",
        ...data
      });
    }

    return res.status(200).json({
      message: "Successful executed query!",
      ...data
    });
  }
}

export default PoolsController;
