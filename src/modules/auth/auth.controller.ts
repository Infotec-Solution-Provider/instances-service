import { Request, Response, Router } from "express";
import * as core from "express-serve-static-core";
import validateDto from "inpulse-crm/utils/src/validateDto";
import { LoginDto } from "./dto/login.dto";
import AuthService from "./auth.service";

class AuthController {
    public readonly router: core.Router;

    constructor() {
        this.router = Router();

        this.router.post("/api/instances/root/auth", validateDto(LoginDto), this.login);
    }

    private async login(req: Request, res: Response): Promise<Response> {
        const loginData = req.body as LoginDto;
        const response = await AuthService.login(loginData);

        return res.status(200).json(response);
    }
}

export default AuthController;