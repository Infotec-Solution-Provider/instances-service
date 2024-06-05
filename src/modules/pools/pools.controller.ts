import { Request, Response, Router } from "express";
import * as core from "express-serve-static-core";
import PoolsService from "./pools.service";

class PoolsController {
    public readonly router: core.Router;

    constructor() {
        this.router = Router();

        this.router.post("/api/instances/:clientName/query", this.executeQuery);
    }

    private async executeQuery(req: Request, res: Response): Promise<Response> {
        const { query, parameters } = req.body;
        const { clientName } = req.params;

        const result = await PoolsService.execute(clientName, query, parameters);

        return res.status(201).json(result);
    }
}

export default PoolsController;