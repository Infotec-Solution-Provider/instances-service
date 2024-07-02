import { NextFunction, Request, Response, Router } from "express";
import * as core from "express-serve-static-core";
import PoolsService from "./pools.service";
import "dotenv/config"

class PoolsController {
    public readonly router: core.Router;

    constructor() {
        this.router = Router();

        this.router.post("/api/instances/:clientName/query", this.checkWhitelistedIp, this.executeQuery);
    }

    private async executeQuery(req: Request, res: Response): Promise<Response> {
        const { query, parameters } = req.body;
        const { clientName } = req.params;

        const result = await PoolsService.execute(clientName, query, parameters);

        return res.status(201).json(result);
    }

    private checkWhitelistedIp(req: Request, res: Response, next: NextFunction): void {
        const allowerIps = ["127.0.0.1", "::1", ...process.env.WHITELIST_IPS?.split(",")];
        if (allowerIps.includes(req.ip)) {
            next();
        } else {
            res.status(403).json({ error: "Access forbidden: address must be on whitelist" });
        }
    }
}

export default PoolsController;