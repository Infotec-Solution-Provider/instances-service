"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("express-async-errors");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const http_errors_1 = require("@rgranatodutra/http-errors");
const servers_controller_1 = __importDefault(require("./modules/servers/servers.controller"));
const instances_controller_1 = __importDefault(require("./modules/instances/instances.controller"));
const parameters_controller_1 = __importDefault(require("./modules/parameters/parameters.controller"));
const getRouterEndpoints_util_1 = __importDefault(require("inpulse-crm/utils/src/getRouterEndpoints.util"));
const pools_controller_1 = __importDefault(require("./modules/pools/pools.controller"));
const auth_controller_1 = __importDefault(require("./modules/auth/auth.controller"));
const app = (0, express_1.default)();
const controllers = {
    instances: new instances_controller_1.default(),
    servers: new servers_controller_1.default(),
    parameters: new parameters_controller_1.default(),
    pools: new pools_controller_1.default(),
    auth: new auth_controller_1.default()
};
app.use(express_1.default.json());
app.use((0, cors_1.default)());
app.use(controllers.auth.router);
app.use(controllers.instances.router);
app.use(controllers.servers.router);
app.use(controllers.parameters.router);
app.use(controllers.pools.router);
Object.values(controllers).forEach(c => {
    const e = (0, getRouterEndpoints_util_1.default)(c.router, "");
    e.forEach(r => console.log(`[ROUTE] ${r}`));
});
app.use(http_errors_1.handleRequestError);
exports.default = app;
//# sourceMappingURL=app.js.map