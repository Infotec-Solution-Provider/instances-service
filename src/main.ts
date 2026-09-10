import "dotenv/config";
import "express-async-errors";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { handleRequestError } from "@rgranatodutra/http-errors";
import InstancesController from "./controllers/instances.controller";
import ServersController from "./controllers/servers.controller";
import ParametersController from "./controllers/parameters.controller";
import PoolsController from "./controllers/pools.controller";
import AuthController from "./controllers/auth.controller";
import GeoController from "./controllers/geo.controller";
import { Logger, logRoutes } from "@in.pulse-crm/utils";
import { startZeroTierRecovery } from "./services/zerotier-recovery.service";

const app = express();
const appPort = Number(process.env["LISTEN_PORT"]) || 8000;

const controllers = {
	instances: new InstancesController(),
	servers: new ServersController(),
	parameters: new ParametersController(),
	pools: new PoolsController(),
	auth: new AuthController(),
	geo: new GeoController(),
};

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ limit: "20mb", extended: true }));
app.use(cors());
app.use(controllers.auth.router);
app.use(controllers.instances.router);
app.use(controllers.servers.router);
app.use(controllers.parameters.router);
app.use(controllers.pools.router);
app.use(controllers.geo.router);

logRoutes(
	"",
	Object.values(controllers).map((c) => c.router),
);

app.use((err: Error, req: Request, _res: Response, next: NextFunction) => {
	Logger.error(req.url, err);
	next(err);
});

app.use(handleRequestError);

app.listen(appPort, () => {
	console.log(`App is running on port ${appPort}`);
	startZeroTierRecovery();
});
