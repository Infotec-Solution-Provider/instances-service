import express, { Request, RequestHandler, Response, Router } from "express";
import * as core from "express-serve-static-core";
import "dotenv/config";
import PoolsService from "../services/pools.service";
import validateDto from "inpulse-crm/utils/src/validateDto";
import { QueryDto } from "../dtos/query.dto";

// The production bootstrap already provides this reviewed direct-transport guard.
// Keep its active module and the existing pool service unchanged in this overlay.
const internal_transport_1 = require("../utils/internal-transport") as { requireInternalTransport: RequestHandler };
type DirectPoolService = { getOrCreatePool(instance: string): Promise<{ query(query: string, parameters: unknown): Promise<unknown> }> };

class PoolsController {
	public readonly router: core.Router;

	constructor() {
		this.router = Router();
		this.router.use("/api/instances/:clientName/query", internal_transport_1.requireInternalTransport);
		this.router.use("/api/instances/:clientName/query-once", internal_transport_1.requireInternalTransport);

		// Ensure this route accepts larger payloads for big queries/parameters
		this.router.use(express.json({ limit: "20mb" }));
		this.router.use(express.urlencoded({ limit: "20mb", extended: true }));

		this.router.post(
			"/api/instances/:clientName/query",
			validateDto(QueryDto),
			this.executeQuery,
		);
		this.router.post(
			"/api/instances/:clientName/query-once",
			validateDto(QueryDto),
			this.executeQueryOnce,
		);
	}

	private async executeQueryOnce(req: Request, res: Response): Promise<Response> {
		const { query, parameters } = req.body as QueryDto;
		try {
			// The active ClientPool.query invokes the driver once. PoolsService.query
			// retries on connection loss and must never wrap this route.
			const pool = await (PoolsService as unknown as DirectPoolService).getOrCreatePool(req.params["clientName"]!);
			const result = await pool.query(query, parameters);
			return res.status(200).json({ message: "Consulta concluída.", result });
		} catch {
			// A lost response may follow COMMIT: no retry and no SQL/credentials in the response.
			return res.status(503).json({ message: "Não foi possível confirmar a operação no banco.", code: "TENANT_QUERY_FAILED", outcome: "UNKNOWN" });
		}
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
