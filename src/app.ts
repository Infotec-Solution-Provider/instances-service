import "express-async-errors";
import express from "express";
import cors from "cors";
import { handleRequestError } from "@rgranatodutra/http-errors";
import ServersController from "./modules/servers/servers.controller";
import InstancesController from "./controllers/instances.controller";
import ParametersController from "./modules/parameters/parameters.controller";
import getRouterEndpoints from "inpulse-crm/utils/src/getRouterEndpoints.util";
import PoolsController from "./modules/pools/pools.controller";
import AuthController from "./modules/auth/auth.controller";

const app = express();

const controllers = {
    instances: new InstancesController(),
    servers: new ServersController(),
    parameters: new ParametersController(),
    pools: new PoolsController(),
    auth: new AuthController()
}

app.use(express.json());
app.use(cors());
app.use(controllers.auth.router);
app.use(controllers.instances.router);
app.use(controllers.servers.router);
app.use(controllers.parameters.router);
app.use(controllers.pools.router);

Object.values(controllers).forEach(c => {
    const e = getRouterEndpoints(c.router, "");
    e.forEach(r => console.log(`[ROUTE] ${r}`));
});

app.use(handleRequestError);

export default app;