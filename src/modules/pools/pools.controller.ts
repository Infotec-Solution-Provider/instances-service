import { NextFunction, Request, Response, Router } from "express";
import * as core from "express-serve-static-core";
import PoolsService from "./pools.service";

class PoolsController {
    public readonly router: core.Router;

    constructor() {
        this.router = Router();

        this.router.post("/api/instances/:clientName/query", this.checkLocalhost, this.executeQuery);
    }

    private async executeQuery(req: Request, res: Response): Promise<Response> {
        const { query, parameters } = req.body;
        const { clientName } = req.params;

        const result = await PoolsService.execute(clientName, query, parameters);

        return res.status(201).json(result);
    }

    private checkLocalhost(req: Request, res: Response, next: NextFunction): void {
        const localhostIps = ["127.0.0.1", "::1"];
        if (localhostIps.includes(req.ip)) {
            next();
        } else {
            res.status(403).json({ error: "Access forbidden: Requests are only allowed from localhost" });
        }
    }
}

export default PoolsController;