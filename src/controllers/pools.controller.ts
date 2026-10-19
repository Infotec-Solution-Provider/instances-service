import express, { Request, Response, Router } from "express";
import * as core from "express-serve-static-core";
import "dotenv/config";
import PoolsService from "../services/pools.service";
import validateDto from "inpulse-crm/utils/src/validateDto";
import { QueryDto } from "../dtos/query.dto";

class PoolsController {
	public readonly router: core.Router;

	constructor(private readonly queryOnce: typeof PoolsService.query = PoolsService.query.bind(PoolsService)) {
		this.router = Router();

		// Ensure this route accepts larger payloads for big queries/parameters
		this.router.use(express.json({ limit: "20mb" }));
		this.router.use(express.urlencoded({ limit: "20mb", extended: true }));

		this.router.post(
			"/api/instances/:clientName/query",
			validateDto(QueryDto),
			this.executeQuery,
		);
		// New callers use a separate route so an older server cannot silently replay a mutation.
		this.router.post(
			"/api/instances/:clientName/query-once",
			validateDto(QueryDto),
			this.executeQueryOnce,
		);
	}

	private executeQueryOnce = async (req: Request, res: Response): Promise<Response> => {
		const { query, parameters } = req.body as QueryDto;
		try {
			const result = await this.queryOnce(req.params["clientName"]!, query, parameters, {
				retryOnConnectionLoss: false,
			});
			return res.status(200).json({ message: "Consulta concluída.", result });
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") {
				return res.status(409).json({
					message: "Registro duplicado.", code: "TENANT_DUPLICATE_KEY", outcome: "UNKNOWN",
				});
			}
			// The connection may have failed after MySQL committed. Never leak driver SQL or imply rollback.
			return res.status(503).json({
				message: "Não foi possível confirmar a operação no banco.", code: "TENANT_QUERY_FAILED", outcome: "UNKNOWN",
			});
		}
	};

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
