import type { NextFunction, Request, Response } from "express";

/** Body-parser errors may retain raw credential payloads. Never send them to the global logger. */
export function adminParserError(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (req.path.replace(/\/$/, "") !== "/api/internal/admin") { next(error); return; }
  const tooLarge = (error as { type?: string })?.type === "entity.too.large";
  res.status(tooLarge ? 413 : 400).json({ message: tooLarge ? "Comando administrativo excede o limite permitido." : "Comando administrativo inválido." });
}
