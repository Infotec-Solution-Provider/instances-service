/** Shared wire protocol. Copy this file unchanged to src/admin in participating services. */
import { createHash, createHmac, createPublicKey, randomUUID, sign, timingSafeEqual, verify } from "node:crypto";

export type AdminEnvironment = "production" | "homolog";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface AdminActor { instance: "infotec"; userId: number; role: "ADMIN"; name: string }
export interface AdminTarget { scope?: "INSTANCE" | "SECTOR" | "USER"; sectorId?: number; userId?: number; resourceId?: string | number }
export interface AdminChange { key: string; action: "set" | "reset" | "remove"; value?: Json }
export type AdminAction = "listTenants" | "listSources" | "getSettings" | "getTargets" | "saveSettings" | "applySettings" | "getReceipt" | "getLogs" | "authorizeActor";
export interface AdminCommand {
  action: AdminAction; environment: AdminEnvironment; tenant?: string; source?: string; target?: AdminTarget;
  operationId?: string; revision?: string; changes?: AdminChange[]; search?: string;
  cursor?: string; limit?: number; from?: string; to?: string; level?: string; identifier?: string;
}
export interface AdminSetting {
  key: string; label: string; description: string; category: string;
  type: "boolean" | "number" | "string" | "enum" | "json" | "secret";
  defaultValue?: Json; options?: Array<{ label: string; value: Json }>; min?: number; max?: number; step?: number;
  unit?: string; multiplier?: number; supportedScopes?: string[]; readOnly?: boolean; unavailableReason?: string;
  applyMode?: "dynamic" | "reload" | "restart" | "build"; canReset?: boolean;
}
export interface AdminSnapshot {
  source: string; tenant: string; target?: AdminTarget; revision: string; catalog: AdminSetting[];
  values: Record<string, Json>; secrets?: Record<string, { configured: boolean }>;
  inherited?: Record<string, { value: Json; source: string }>;
  application?: { state: "applied" | "pending" | "build_required" | "unknown"; revision?: string; message?: string };
  resources?: Array<{ id: string | number; label: string }>;
  unavailableReason?: string;
}
export interface AdminDiff { key: string; before?: Json; after?: Json; secretAction?: "defined" | "replaced" | "removed" }
export interface AdminMutationResult {
  operationId: string; state: "COMMITTED"; revision?: string; snapshot?: AdminSnapshot;
  changes?: AdminDiff[]; application?: AdminSnapshot["application"]; message?: string;
}
export interface AdminContext {
  v: 1; iss: string; kid: string; aud: string; environment: AdminEnvironment; actor: AdminActor;
  iat: number; exp: number; nonce: string; method: "POST"; path: "/api/internal/admin";
  bodyHash: string; operationId?: string;
}
export interface AdminPublicKey { kid: string; publicKey: string; environments: AdminEnvironment[]; issuer?: string }
export class AdminProtocolError extends Error {
  constructor(public statusCode: number, message: string) { super(message); this.name = "AdminProtocolError"; }
}
export function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value) {
    return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new AdminProtocolError(400, "Valor de configuração inválido.");
}
export function bodyHash(body: unknown): string { return createHash("sha256").update(canonical(body)).digest("base64url"); }
export function signAdminCommand(command: AdminCommand, actor: AdminActor, options: { privateKey: string; kid: string; issuer: string; audience: string; now?: number }): string {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const context: AdminContext = { v: 1, iss: options.issuer, kid: options.kid, aud: options.audience,
    environment: command.environment, actor, iat: now, exp: now + 30, nonce: randomUUID(),
    method: "POST", path: "/api/internal/admin", bodyHash: bodyHash(command),
    ...(command.operationId ? { operationId: command.operationId } : {}) };
  const encoded = Buffer.from(canonical(context)).toString("base64url");
  return `${encoded}.${sign(null, Buffer.from(encoded), options.privateKey).toString("base64url")}`;
}
export function verifyAdminCommand(header: unknown, command: AdminCommand, options: { keys: AdminPublicKey[]; audience: string; environment: AdminEnvironment; now?: number }): AdminContext {
  if (typeof header !== "string" || header.length > 16000) throw new AdminProtocolError(401, "Autorização administrativa ausente.");
  const parts = header.split(".");
  if (parts.length !== 2) throw new AdminProtocolError(401, "Autorização administrativa inválida.");
  let context: AdminContext;
  try { context = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")); }
  catch { throw new AdminProtocolError(401, "Autorização administrativa inválida."); }
  if (!context || typeof context !== "object" || Array.isArray(context)) throw new AdminProtocolError(401, "Autorização administrativa inválida.");
  const key = options.keys.find(item => item.kid === context.kid && (!item.issuer || item.issuer === context.iss));
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (!key || context.v !== 1 || context.aud !== options.audience || context.environment !== options.environment ||
    command.environment !== options.environment || !key.environments.includes(options.environment) ||
    !Number.isInteger(context.iat) || !Number.isInteger(context.exp) || context.iat > now + 5 || context.exp <= now ||
    context.exp - context.iat > 35 || typeof context.nonce !== "string" || context.nonce.length > 100 ||
    context.method !== "POST" || context.path !== "/api/internal/admin" || context.bodyHash !== bodyHash(command) ||
    context.operationId !== command.operationId || context.actor?.instance !== "infotec" || context.actor?.role !== "ADMIN" ||
    !Number.isSafeInteger(context.actor?.userId) || context.actor.userId <= 0 || typeof context.actor.name !== "string") {
    throw new AdminProtocolError(403, "Contexto administrativo não autorizado.");
  }
  try {
    const publicKey = createPublicKey(key.publicKey);
    if (publicKey.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(parts[0]!), publicKey, Buffer.from(parts[1]!, "base64url"))) throw new Error();
  } catch { throw new AdminProtocolError(403, "Assinatura administrativa inválida."); }
  validateCommand(command);
  return context;
}
export function validateCommand(command: AdminCommand): void {
  const actions: AdminAction[] = ["listTenants", "listSources", "getSettings", "getTargets", "saveSettings", "applySettings", "getReceipt", "getLogs", "authorizeActor"];
  if (!command || !actions.includes(command.action) || !["production", "homolog"].includes(command.environment)) throw new AdminProtocolError(400, "Comando administrativo inválido.");
  if (command.tenant !== undefined && (typeof command.tenant !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(command.tenant))) throw new AdminProtocolError(400, "Tenant inválido.");
  if (command.source !== undefined && (typeof command.source !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(command.source))) throw new AdminProtocolError(400, "Fonte inválida.");
  if (command.target !== undefined) {
    if (!command.target || typeof command.target !== "object" || Array.isArray(command.target) || Object.keys(command.target).some(key=>!["scope","sectorId","userId","resourceId"].includes(key))) throw new AdminProtocolError(400,"Alvo inválido.");
    if (command.target.scope !== undefined && !["INSTANCE","SECTOR","USER"].includes(command.target.scope)) throw new AdminProtocolError(400,"Escopo inválido.");
    for (const key of ["sectorId","userId"] as const) if (command.target[key] !== undefined && (!Number.isSafeInteger(command.target[key]) || command.target[key]! < 1)) throw new AdminProtocolError(400,"Alvo inválido.");
    const id=command.target.resourceId;
    if (id !== undefined && !((typeof id==="string" && id.length>0 && id.length<=200) || (typeof id==="number" && Number.isSafeInteger(id) && id>0))) throw new AdminProtocolError(400,"Recurso inválido.");
  }
  if (command.operationId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(command.operationId)) throw new AdminProtocolError(400, "Identificador de operação inválido.");
  if (["saveSettings", "applySettings", "getReceipt"].includes(command.action) && !command.operationId) throw new AdminProtocolError(400, "Informe a operação.");
  if (command.action === "saveSettings") {
    if (typeof command.revision !== "string" || command.revision.length > 512 || !Array.isArray(command.changes) || !command.changes.length || command.changes.length > 500) throw new AdminProtocolError(400, "Informe revisão e alterações.");
    const keys = new Set<string>();
    for (const change of command.changes) {
      if (!change || typeof change.key !== "string" || change.key.length > 200 || keys.has(change.key) || !["set", "reset", "remove"].includes(change.action) || (change.action === "set" && change.value === undefined)) throw new AdminProtocolError(400, "Alteração inválida ou repetida.");
      keys.add(change.key);
    }
  }
  if (command.limit !== undefined && (!Number.isInteger(command.limit) || command.limit < 1 || command.limit > 1000)) throw new AdminProtocolError(400, "Limite inválido.");
}
export function opaqueRevision(identity: unknown, state: unknown, key = process.env["ADMIN_REVISION_KEY"]): string {
  if (!key || key.length < 32) throw new AdminProtocolError(503, "Chave de revisão administrativa não configurada.");
  return createHmac("sha256", key).update(canonical({ identity, state })).digest("base64url");
}
export function requireRevision(expected: string | undefined, actual: string): void {
  const a = Buffer.from(expected ?? ""); const b = Buffer.from(actual);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AdminProtocolError(409, "A configuração mudou. Recarregue antes de salvar.");
}
export function requestFingerprint(command: AdminCommand, key = process.env["ADMIN_REVISION_KEY"]): string {
  if (!key || key.length < 32) throw new AdminProtocolError(503, "Chave administrativa não configurada.");
  return createHmac("sha256", key).update(canonical(command)).digest("base64url");
}
export function createAdminHandler(audience: string, handler: (command: AdminCommand, context: AdminContext) => Promise<unknown>) {
  return async (req: { headers: Record<string, unknown>; body: AdminCommand }, res: { status: (code: number) => any; json: (value: unknown) => any; setHeader: (name: string, value: string) => void }, _next?: unknown): Promise<void> => {
    res.setHeader("Cache-Control", "no-store, private");
    try {
      const environment = process.env["ADMIN_ENVIRONMENT"];
      if (environment !== "production" && environment !== "homolog") throw new AdminProtocolError(503, "Adaptador administrativo não configurado.");
      let keys: AdminPublicKey[];
      try { keys = JSON.parse(process.env["ADMIN_CONTROL_PUBLIC_KEYS"] || "[]"); } catch { throw new AdminProtocolError(503, "Chaves administrativas inválidas."); }
      if (!Array.isArray(keys) || keys.length === 0) throw new AdminProtocolError(503, "Adaptador administrativo não configurado.");
      const context = verifyAdminCommand(req.headers["x-admin-context"], req.body, { keys, audience, environment });
      const result = await handler(req.body, context);
      res.json(result);
    } catch (error) {
      const code = Number((error as { statusCode?: number }).statusCode);
      const status = Number.isInteger(code) && code >= 400 && code <= 599 ? code : 500;
      res.status(status).json({ message: error instanceof AdminProtocolError ? error.message : "Não foi possível concluir a operação administrativa." });
    }
  };
}
