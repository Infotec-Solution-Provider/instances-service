"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mysql2_1 = require("mysql2");
const servers_service_1 = __importDefault(require("../servers/servers.service"));
const client_pool_entity_1 = __importDefault(require("./entity/client-pool.entity"));
const http_errors_1 = require("@rgranatodutra/http-errors");
class PoolsService {
    static async getOrCreatePool(clientName) {
        const findPool = PoolsService.pools.find((cp) => cp.name === clientName);
        if (!findPool) {
            const server = await servers_service_1.default.get(clientName);
            if (!server) {
                throw new http_errors_1.NotFoundError(`${clientName}'s database not found`);
            }
            const { host, port, username: user, password, database } = server;
            const pool = (0, mysql2_1.createPool)({
                host, port, user, password, database,
                maxPreparedStatements: 1000
            });
            const clientPool = new client_pool_entity_1.default(clientName, pool);
            PoolsService.pools.push(clientPool);
            return clientPool;
        }
        return findPool;
    }
    static async execute(clientName, query, parameters) {
        const pool = await PoolsService.getOrCreatePool(clientName);
        return pool.execute(query, parameters);
    }
}
PoolsService.pools = [];
exports.default = PoolsService;
//# sourceMappingURL=pools.service.js.map