import { AsyncLocalStorage } from "node:async_hooks";
import { AdminActor, AdminChange, AdminCommand, AdminDiff, AdminMutationResult, AdminProtocolError, AdminSetting, AdminSnapshot, Json, canonical, opaqueRevision, requestFingerprint } from "./admin-protocol";

const actorContext = new AsyncLocalStorage<AdminActor>();
export const withAdminActor = <T>(actor: AdminActor, work: () => T): T => actorContext.run(actor, work);

export type Query = <T = unknown>(sql: string, params?: unknown[]) => Promise<T>;
export const receiptTable = "admin_operation_receipts";
export const secretKey = (key: string): boolean => /password|senha|secret|token|api.?key|sip_key|credential|authorization|private.?key/i.test(key);
export function json(value: unknown): Json {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return String(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(json);
  return Object.fromEntries(Object.entries(value as object).map(([key, item]) => [key, json(item)]));
}
export function containsSecret(key: string, value: unknown): boolean {
  if (secretKey(key)) return true;
  if (typeof value === "string") {
    if (/[a-z]+:\/\/[^\s/:@]+:[^\s/@]+@|[?&](?:token|key|password|secret)=|\bBearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value)) return true;
    if (/^\s*[\[{]/.test(value)) { try { return containsSecret("", JSON.parse(value)); } catch { /* ordinary string */ } }
  }
  return !!(value && typeof value === "object" && Object.entries(value).some(([name, item]) => containsSecret(name, item)));
}
export function tenant(command: AdminCommand): string {
  if (!command.tenant) throw new AdminProtocolError(400, "Selecione o tenant.");
  return command.tenant;
}
export function snapshot(command: AdminCommand, state: Record<string, unknown>, catalog: AdminSetting[], application: AdminSnapshot["application"] = { state: "unknown" }): AdminSnapshot {
  const values: Record<string, Json> = {}, secrets: NonNullable<AdminSnapshot["secrets"]> = {};
  for (const setting of catalog) {
    const value = state[setting.key];
    if (setting.type === "secret" || containsSecret(setting.key, value)) {
      setting.type = "secret";
      delete setting.defaultValue;
      delete setting.options;
      secrets[setting.key] = { configured: value !== null && value !== undefined && value !== "" };
    } else values[setting.key] = setting.type === "boolean" && value != null ? value === true || value === "true" || value === 1 : json(value);
  }
  return { source: command.source!, tenant: tenant(command), ...(command.target ? { target: command.target } : {}), revision: opaqueRevision({ environment: command.environment, tenant: command.tenant, source: command.source, target: command.target ?? null }, json(state)), catalog, values, secrets, ...(application ? { application } : {}) };
}
export function diff(changes: AdminChange[], before: Record<string, unknown>, after: Record<string, unknown>, catalog: AdminSetting[]): AdminDiff[] {
  return changes.map(change => {
    const a = before[change.key], b = after[change.key];
    if (catalog.find(field => field.key === change.key)?.type === "secret" || containsSecret(change.key, a) || containsSecret(change.key, b))
      return { key: change.key, secretAction: b === null || b === undefined || b === "" ? "removed" : a === null || a === undefined || a === "" ? "defined" : "replaced" };
    return { key: change.key, before: json(a), after: json(b) };
  });
}
export function validateChanges(command: AdminCommand, catalog: AdminSetting[]): AdminChange[] {
  for (const change of command.changes ?? []) {
    const field = catalog.find(item => item.key === change.key);
    if (!field || field.readOnly) throw new AdminProtocolError(400, "Campo desconhecido ou somente leitura.");
    if (change.action === "reset" && !field.canReset) throw new AdminProtocolError(400, `${field.label}: não há padrão disponível.`);
    if (change.action !== "set") continue;
    const value = change.value;
    if (field.type === "boolean" && typeof value !== "boolean" && value !== "true" && value !== "false") throw new AdminProtocolError(400, `${field.label}: valor booleano inválido.`);
    if (field.type === "number" && (value === null || value === "" || !["number", "string"].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) < (field.min ?? -Number.MAX_SAFE_INTEGER) || Number(value) > (field.max ?? Number.MAX_SAFE_INTEGER))) throw new AdminProtocolError(400, `${field.label}: número inválido.`);
    if (field.options && !field.options.some(option => option.value === value)) throw new AdminProtocolError(400, `${field.label}: opção inválida.`);
    if (["string", "secret"].includes(field.type) && value !== null && typeof value !== "string" && !(field.type === "secret" && typeof value === "object")) throw new AdminProtocolError(400, `${field.label}: texto inválido.`);
    if (Buffer.byteLength(JSON.stringify(value)) > 262144) throw new AdminProtocolError(400, "Valor muito extenso.");
  }
  return command.changes ?? [];
}
export async function readReceipt(query: Query, command: AdminCommand, lock = false): Promise<AdminMutationResult | null> {
  const rows = await query<{ request_hash: string; result_json: string | object }[]>(`SELECT request_hash,result_json FROM ${receiptTable} WHERE operation_id=?${lock ? " FOR UPDATE" : ""}`, [command.operationId!]);
  if (!rows[0]) return null;
  if (command.action !== "getReceipt" && rows[0].request_hash !== requestFingerprint(command)) throw new AdminProtocolError(409, "Operação reutilizada com outro conteúdo.");
  const stored = (typeof rows[0].result_json === "string" ? JSON.parse(rows[0].result_json) : rows[0].result_json) as { actor: { instance: string; userId: number }; tenant: string; source: string; target: unknown; result: AdminMutationResult };
  const actor = actorContext.getStore();
  if (!actor || stored.actor?.instance !== actor.instance || stored.actor.userId !== actor.userId || stored.tenant !== command.tenant || stored.source !== command.source || canonical(stored.target ?? null) !== canonical(command.target ?? null)) throw new AdminProtocolError(409, "O recibo pertence a outro ator ou recurso.");
  const result = stored.result;
  if (!result) throw new AdminProtocolError(503, "Operação iniciada sem confirmação. A ação não será repetida automaticamente.");
  if (result.snapshot && (result.snapshot.tenant !== command.tenant || result.snapshot.source !== command.source)) throw new AdminProtocolError(409, "O recibo pertence a outro recurso.");
  return result;
}
export async function writeReceipt(query: Query, command: AdminCommand, result: AdminMutationResult): Promise<void> {
  await insertReceipt(query, command, result);
}
function receiptEnvelope(command: AdminCommand, result: AdminMutationResult | null) {
  const actor = actorContext.getStore();
  if (!actor) throw new AdminProtocolError(403, "Ator administrativo ausente.");
  return { actor: { instance: actor.instance, userId: actor.userId }, tenant: command.tenant!, source: command.source!, target: command.target ?? null, result };
}
async function insertReceipt(query: Query, command: AdminCommand, result: AdminMutationResult | null): Promise<void> {
  const stored = receiptEnvelope(command, result);
  await query(`INSERT INTO ${receiptTable} (operation_id,request_hash,result_json,created_at) VALUES (?,?,?,UTC_TIMESTAMP())`, [command.operationId!, requestFingerprint(command), JSON.stringify(stored)]);
}
export const beginApplyReceipt = (query: Query, command: AdminCommand): Promise<void> => insertReceipt(query, command, null);
export async function completeReceipt(query: Query, command: AdminCommand, result: AdminMutationResult): Promise<void> {
  const hash = requestFingerprint(command);
  const rows = await query<{ request_hash: string }[]>(`SELECT request_hash FROM ${receiptTable} WHERE operation_id=? FOR UPDATE`, [command.operationId!]);
  if (rows[0]?.request_hash !== hash) throw new AdminProtocolError(409, "Recibo de aplicação inválido.");
  await query(`UPDATE ${receiptTable} SET result_json=? WHERE operation_id=? AND request_hash=?`, [JSON.stringify(receiptEnvelope(command, result)), command.operationId!, hash]);
}
export async function requireTransactional(query: Query, tables: string[]): Promise<void> {
  for (const name of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new AdminProtocolError(400, "Tabela administrativa inválida.");
    await query(`SELECT 1 FROM \`${name}\` LIMIT 0`);
  }
  const rows = await query<{ name: string; engine: string }[]>(`SELECT TABLE_NAME AS name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${tables.map(() => "?").join(",")})`, tables);
  if (tables.some(name => !rows.some(row => row.name === name && row.engine.toUpperCase() === "INNODB"))) throw new AdminProtocolError(503, "A fonte precisa das tabelas transacionais e da migração de recibos administrativos.");
}
