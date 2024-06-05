import { InternalServerError, UnauthenticatedError, UnauthorizedError } from "@rgranatodutra/http-errors";
import { randomUUID } from "crypto";
import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken"
import { LoginDto } from "./dto/login.dto";
import { prisma } from "../database/prisma.service";

class AuthService {
    private static secret = randomUUID();

    private static async generateToken() {
        return new Promise<string>((res, rej) => {
            jwt.sign({ admin: true }, this.secret, { expiresIn: '1d' }, (err, token) => {
                if (err) {
                    rej(err);
                } else {
                    res(token);
                }
            });
        });
    }

    private static async validateToken(token: string, onValid: () => void, onError: (err: any) => void) {
        try {
            jwt.verify(token, this.secret, (err, _) => {
                if (err) {
                    onError(err);
                } else {
                    onValid();
                }
            });
        } catch (err) {
            throw new UnauthenticatedError("invalid token", err);
        }
    }

    public static async validateTokenMiddleware(req: Request, res: Response, next: NextFunction) {
        const token = req.headers["authorization"]?.split(" ")[1] || "";

        if (!token) {
            throw new UnauthenticatedError("missing authorization token");
        }

        AuthService.validateToken(
            String(token),
            () => next(),
            (error) => res.status(401).json({ message: "invalid token", error })
        );
    }

    public static async login({ login, password }: LoginDto): Promise<{ token: string }> {
        const findUser = await prisma.user.findFirst({
            where: { login }
        });

        if (!findUser) {
            throw new UnauthorizedError("invalid login or password");
        }

        const passwordMatch = findUser.password === password;

        if (!passwordMatch) {
            throw new UnauthorizedError("invalid login or password");
        }

        try {

            const token = await this.generateToken();

            return { token }
        } catch (err) {
            throw new InternalServerError("failed to generate token", err);
        }
    }
}

export default AuthService;