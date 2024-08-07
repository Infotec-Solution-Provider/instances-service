"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const validateDto_1 = __importDefault(require("inpulse-crm/utils/src/validateDto"));
const login_dto_1 = require("./dto/login.dto");
const auth_service_1 = __importDefault(require("./auth.service"));
class AuthController {
    constructor() {
        this.router = (0, express_1.Router)();
        this.router.post("/api/instances/root/auth", (0, validateDto_1.default)(login_dto_1.LoginDto), this.login);
    }
    async login(req, res) {
        const loginData = req.body;
        const response = await auth_service_1.default.login(loginData);
        return res.status(200).json(response);
    }
}
exports.default = AuthController;
//# sourceMappingURL=auth.controller.js.map