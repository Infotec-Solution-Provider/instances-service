import {
  InternalServerError,
  UnauthenticatedError,
  UnauthorizedError,
} from "@rgranatodutra/http-errors";
import { randomUUID } from "crypto";
import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { LoginDto } from "../dtos/login.dto";
import { prisma } from "./prisma.service";

class AuthService {
  private static secret = randomUUID();

  private static async generateToken() {
    return new Promise<string>((res, rej) => {
      jwt.sign(
        { admin: true },
        this.secret,
        { expiresIn: "1d" },
        (err, token) => {
          if (err || !token) {
            rej(new InternalServerError("Falha ao gerar token.", err));
          } else {
            res(token);
          }
        }
      );
    });
  }

  private static async validateToken(
    token: string,
    onValid: () => void,
    onError: (err: any) => void
  ) {
    jwt.verify(token, this.secret, (err, _) => {
      if (err) {
        onError(err);
      } else {
        onValid();
      }
    });
  }

  public static async validateTokenMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    const token = req.headers["authorization"]?.split(" ")[1] || "";

    if (!token) {
      throw new UnauthenticatedError("Faça o login para acessar este recurso.");
    }

    AuthService.validateToken(
      String(token),
      () => next(),
      (error) =>
        res
          .status(401)
          .json({ message: "Sessão expirada, faça o login novamente.", error })
    );
  }

  public static async login({
    login,
    password,
  }: LoginDto): Promise<{ token: string }> {
    const findUser = await prisma.user.findFirst({
      where: { login },
    });

    if (!findUser) {
      throw new UnauthorizedError("Login e/ou senha incorreto(s).");
    }

    const passwordMatch = findUser.password === password;

    if (!passwordMatch) {
      throw new UnauthorizedError("Login e/ou senha incorreto(s).");
    }

    const token = await this.generateToken();

    return { token };
  }
}

export default AuthService;
