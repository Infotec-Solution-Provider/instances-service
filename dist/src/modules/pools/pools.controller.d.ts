import * as core from "express-serve-static-core";
import "dotenv/config";
declare class PoolsController {
    readonly router: core.Router;
    constructor();
    private executeQuery;
    private checkWhitelistedIp;
}
export default PoolsController;
