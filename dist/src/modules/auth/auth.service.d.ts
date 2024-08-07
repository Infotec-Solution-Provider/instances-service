import { NextFunction, Request, Response } from "express";
import { LoginDto } from "./dto/login.dto";
declare class AuthService {
    private static secret;
    private static generateToken;
    private static validateToken;
    static validateTokenMiddleware(req: Request, res: Response, next: NextFunction): Promise<void>;
    static login({ login, password }: LoginDto): Promise<{
        token: string;
    }>;
}
export default AuthService;
