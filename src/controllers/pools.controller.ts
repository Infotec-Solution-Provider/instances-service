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
			this.executeQuery,
		);
	}

	private async executeQuery(req: Request, res: Response): Promise<Response> {
		const { query, parameters } = req.body as QueryDto;

		const result = await PoolsService.query(
			req.params["clientName"]!,
			query,
			parameters,
		);

		return res.status(200).json({
			message: "Successful executed query!",
			result,
		});
	}
}

export default PoolsController;
