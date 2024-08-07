"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_errors_1 = require("@rgranatodutra/http-errors");
const crypto_1 = require("crypto");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const prisma_service_1 = require("../database/prisma.service");
class AuthService {
    static async generateToken() {
        return new Promise((res, rej) => {
            jsonwebtoken_1.default.sign({ admin: true }, this.secret, { expiresIn: '1d' }, (err, token) => {
                if (err) {
                    rej(err);
                }
                else {
                    res(token);
                }
            });
        });
    }
    static async validateToken(token, onValid, onError) {
        try {
            jsonwebtoken_1.default.verify(token, this.secret, (err, _) => {
                if (err) {
                    onError(err);
                }
                else {
                    onValid();
                }
            });
        }
        catch (err) {
            throw new http_errors_1.UnauthenticatedError("invalid token", err);
        }
    }
    static async validateTokenMiddleware(req, res, next) {
        const token = req.headers["authorization"]?.split(" ")[1] || "";
        if (!token) {
            throw new http_errors_1.UnauthenticatedError("missing authorization token");
        }
        AuthService.validateToken(String(token), () => next(), (error) => res.status(401).json({ message: "invalid token", error }));
    }
    static async login({ login, password }) {
        const findUser = await prisma_service_1.prisma.user.findFirst({
            where: { login }
        });
        if (!findUser) {
            throw new http_errors_1.UnauthorizedError("invalid login or password");
        }
        const passwordMatch = findUser.password === password;
        if (!passwordMatch) {
            throw new http_errors_1.UnauthorizedError("invalid login or password");
        }
        try {
            const token = await this.generateToken();
            return { token };
        }
        catch (err) {
            throw new http_errors_1.InternalServerError("failed to generate token", err);
        }
    }
}
AuthService.secret = (0, crypto_1.randomUUID)();
exports.default = AuthService;
//# sourceMappingURL=auth.service.js.map