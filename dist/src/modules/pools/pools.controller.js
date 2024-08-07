"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const pools_service_1 = __importDefault(require("./pools.service"));
require("dotenv/config");
class PoolsController {
    constructor() {
        this.router = (0, express_1.Router)();
        this.router.post("/api/instances/:clientName/query", this.checkWhitelistedIp, this.executeQuery);
    }
    async executeQuery(req, res) {
        const { query, parameters } = req.body;
        const { clientName } = req.params;
        const result = await pools_service_1.default.execute(clientName, query, parameters);
        return res.status(201).json(result);
    }
    checkWhitelistedIp(req, res, next) {
        const allowerIps = ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost", ...process.env.WHITELIST_IPS?.split(",")];
        if (allowerIps.includes(req.ip) || req.hostname === "contec.inf.br") {
            next();
        }
        else {
            res.status(403).json({ error: "Access forbidden: address must be on whitelist" });
        }
    }
}
exports.default = PoolsController;
//# sourceMappingURL=pools.controller.js.map