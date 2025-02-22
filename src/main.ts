import "dotenv/config";
import "express-async-errors";
import express from "express";
import cors from "cors";
import { handleRequestError } from "@rgranatodutra/http-errors";

import InstancesController from "./controllers/instances.controller";

import getRouterEndpoints from "inpulse-crm/utils/src/getRouterEndpoints.util";
import ServersController from "./controllers/servers.controller";
import ParametersController from "./controllers/parameters.controller";
import PoolsController from "./controllers/pools.controller";
import AuthController from "./controllers/auth.controller";

const app = express();
const appPort = Number(process.env["LISTEN_PORT"]) || 8000;

const controllers = {
  instances: new InstancesController(),
  servers: new ServersController(),
  parameters: new ParametersController(),
  pools: new PoolsController(),
  auth: new AuthController(),
};

app.use(express.json());
app.use(cors());
app.use(controllers.auth.router);
app.use(controllers.instances.router);
app.use(controllers.servers.router);
app.use(controllers.parameters.router);
app.use(controllers.pools.router);

Object.values(controllers).forEach((c) => {
  const e = getRouterEndpoints(c.router, "");
  e.forEach((r) => console.log(`[ROUTE] ${r}`));
});

app.use(handleRequestError);

app.listen(appPort, () => console.log(`App is running on port ${appPort}`));
