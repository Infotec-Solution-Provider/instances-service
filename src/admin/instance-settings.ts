import { Prisma } from "@prisma/client";
import { createConnection } from "mysql2/promise";
import { prisma } from "../services/prisma.service";
import PoolsService from "../services/pools.service";
import { invalidateTenantDatabase } from "../services/tenant-database.service";
import { AdminCommand, AdminMutationResult, AdminProtocolError, AdminSetting, AdminSnapshot, canonical, requireRevision } from "./admin-protocol";
import { completeReceipt, containsSecret, diff, json, Query, readReceipt, requireTransactional, snapshot, tenant, validateChanges, writeReceipt } from "./settings-utils";
import { openConfiguration, sealConfiguration } from "./saved-configuration";

type Db = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
export const prismaQuery = (db: Db): Query => async <T>(sql: string, params: unknown[] = []) =>
  (/^\s*(SELECT|SHOW)\b/i.test(sql) ? await db.$queryRawUnsafe(sql, ...params) : await db.$executeRawUnsafe(sql, ...params)) as T;
const databaseCatalog: AdminSetting[] = [
  { key: "host", label: "Servidor MySQL", description: "Endereço do banco CRM deste tenant.", category: "Conexão CRM", type: "string", applyMode: "reload" },
  { key: "port", label: "Porta MySQL", description: "Porta TCP do servidor MySQL.", category: "Conexão CRM", type: "number", min: 1, max: 65535, step: 1, applyMode: "reload" },
  { key: "username", label: "Usuário MySQL", description: "Identidade de acesso ao banco CRM.", category: "Conexão CRM", type: "string", applyMode: "reload" },
  { key: "password", label: "Senha MySQL", description: "Preencha somente para substituir a senha.", category: "Conexão CRM", type: "secret", applyMode: "reload" },
  { key: "database", label: "Banco CRM", description: "Nome físico do banco CRM.", category: "Conexão CRM", type: "string", applyMode: "reload" },
];
const savedKey = (command: AdminCommand) => `${command.environment}:database:${tenant(command)}`;
type State = { state: Record<string, unknown>; catalog: AdminSetting[]; active?: Record<string, unknown> };
async function state(command: AdminCommand, query: Query, lock = false): Promise<State> {
  const clients = await query<{ name: string }[]>(`SELECT name FROM clients WHERE name=?${lock ? " FOR UPDATE" : ""}`, [tenant(command)]);
  if (!clients[0]) throw new AdminProtocolError(404, "Tenant não encontrado.");
  if (command.source === "database") {
    const rows = await query<Record<string, unknown>[]>(`SELECT host,port,username,password,\`database\` FROM clients_servers WHERE instance_name=?${lock ? " FOR UPDATE" : ""}`, [command.tenant!]);
    const staged = await query<{ payload_encrypted: string }[]>(`SELECT payload_encrypted FROM admin_saved_configurations WHERE resource_key=?${lock ? " FOR UPDATE" : ""}`, [savedKey(command)]);
    const active = rows[0] ?? {};
    return { state: staged[0] ? openConfiguration(savedKey(command), staged[0].payload_encrypted) : { ...active }, active, catalog: databaseCatalog.map(item => ({ ...item })) };
  }
  const rows = await query<{ parameters: unknown }[]>(`SELECT parameters FROM clients_parameters WHERE instance_name=?${lock ? " FOR UPDATE" : ""}`, [command.tenant!]);
  const raw = rows[0]?.parameters, parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (parsed != null && (typeof parsed !== "object" || Array.isArray(parsed))) throw new AdminProtocolError(503, "Parâmetros do tenant não são um objeto JSON.");
  const values = (parsed ?? {}) as Record<string, unknown>;
  // No typed runtime consumer of clients_parameters was identified in the services/SDK inventory.
  const catalog: AdminSetting[] = Object.entries(values).map(([key, value]) => ({ key, label: key, description: "Chave existente ainda sem consumidor tipado identificado. Classifique o consumidor antes de habilitar edição.", category: "Aguardando classificação", type: containsSecret(key, value) ? "secret" : "json", readOnly: true, unavailableReason: "Consumidor e contrato ainda não classificados.", canReset: false }));
  return { state: values, catalog };
}
function view(command: AdminCommand, current: State): AdminSnapshot {
  if (command.source !== "database") return snapshot(command, current.state, current.catalog, { state: "unknown", message: "Chaves sem contrato de consumo são somente leitura." });
  const active = current.active ?? {}, identical = canonical(json(current.state)) === canonical(json(active));
  const saved = snapshot(command, { ...current.state, _activeState: active }, current.catalog, { state: identical ? "applied" : "pending", message: identical ? "Destino salvo coincide com o destino ativo." : "Destino desejado salvo e criptografado; a conexão ativa permanece inalterada até reaplicar." });
  const activeSnapshot = snapshot(command, { ...active, _activeState: active }, current.catalog.map(field => ({ ...field })));
  saved.application!.revision = activeSnapshot.revision;
  saved.inherited = Object.fromEntries(current.catalog.filter(field => field.type !== "secret").map(field => [field.key, { value: json(active[field.key]), source: "ACTIVE" }]));
  return saved;
}
function validateDatabase(after: Record<string, unknown>): void {
  if (![after["host"], after["username"], after["database"]].every(value => typeof value === "string" && value.trim().length > 0 && value.length <= 255) || !Number.isInteger(Number(after["port"])) || Number(after["port"]) < 1 || Number(after["port"]) > 65535 || typeof after["password"] !== "string") throw new AdminProtocolError(400, "Preencha os dados obrigatórios da conexão.");
}
async function testDatabase(after: Record<string, unknown>): Promise<void> {
  let connection: Awaited<ReturnType<typeof createConnection>> | undefined;
  try {
    connection = await createConnection({ host: String(after["host"]), port: Number(after["port"]), user: String(after["username"]), password: String(after["password"]), database: String(after["database"]), connectTimeout: 5000 });
    await connection.query({ sql: "SELECT 1", timeout: 5000 });
  } catch { throw new AdminProtocolError(400, "O destino CRM não pôde ser validado. A conexão ativa não foi alterada."); }
  finally { connection?.destroy(); }
}
export async function instanceSettings(command: AdminCommand): Promise<unknown> {
  const query = prismaQuery(prisma);
  if (command.action === "listTenants") return { tenants: await query<{ id: string; name: string }[]>("SELECT name AS id,name FROM clients ORDER BY name") };
  if (!["tenant", "database"].includes(command.source ?? "")) throw new AdminProtocolError(400, "Fonte não suportada pelo catálogo de tenants.");
  if (command.action === "getReceipt") return await readReceipt(query, command) ?? { found: false };
  if (command.action === "getSettings") return view(command, await state(command, query));
  if (!["saveSettings", "applySettings"].includes(command.action)) throw new AdminProtocolError(400, "Ação não suportada.");
  if (command.source === "tenant") throw new AdminProtocolError(422, "Chaves do catálogo de tenants aguardam classificação de seus consumidores e são somente leitura.");
  let committed: AdminMutationResult;
  try {
    committed = await prisma.$transaction(async tx => {
      const execute = prismaQuery(tx);
      await requireTransactional(execute, ["clients", "clients_servers", "admin_saved_configurations", "admin_operation_receipts"]);
      const existing = await readReceipt(execute, command, true);
      if (existing) return existing;
      const before = await state(command, execute, true);
      requireRevision(command.revision, view(command, before).revision);
      const changes = command.action === "saveSettings" ? validateChanges(command, before.catalog) : [];
      const desired = { ...before.state };
      for (const change of changes) {
        if (change.action !== "set") throw new AdminProtocolError(400, "Informe o novo valor; campos da conexão são obrigatórios.");
        desired[change.key] = change.key === "port" ? Number(change.value) : change.value;
      }
      validateDatabase(desired);
      if (command.action === "saveSettings") {
        await execute("INSERT INTO admin_saved_configurations (resource_key,payload_encrypted,updated_at) VALUES (?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE payload_encrypted=VALUES(payload_encrypted),updated_at=VALUES(updated_at)", [savedKey(command), sealConfiguration(savedKey(command), desired)]);
      } else {
        await testDatabase(desired);
        await execute("INSERT INTO clients_servers (instance_name,host,port,username,password,`database`) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE host=VALUES(host),port=VALUES(port),username=VALUES(username),password=VALUES(password),`database`=VALUES(`database`)", [command.tenant!, desired["host"], Number(desired["port"]), desired["username"], desired["password"], desired["database"]]);
      }
      const stored = await state(command, execute), saved = view(command, stored);
      if (command.action === "applySettings") saved.application = { state: "pending", revision: saved.revision, message: "Destino confirmado no catálogo; aguardando invalidação dos pools deste tenant." };
      const result: AdminMutationResult = { operationId: command.operationId!, state: "COMMITTED", revision: saved.revision, snapshot: saved, changes: diff(changes, before.state, stored.state, before.catalog), application: saved.application! };
      await writeReceipt(execute, command, result);
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000 });
  } catch (error) {
    if ((error as { code?: string })?.code === "P2034") throw new AdminProtocolError(409, "Houve uma alteração simultânea. Recarregue a configuração.");
    throw error;
  }
  if (command.action === "applySettings" && committed.application?.state === "pending") {
    await PoolsService.invalidate(tenant(command));
    await invalidateTenantDatabase(tenant(command));
    const saved = view(command, await state(command, query));
    saved.application = { state: saved.revision === committed.revision ? "applied" : "pending", revision: committed.revision!, message: "Pools anteriores retirados das novas consultas; transações em andamento mantêm suas conexões até terminar." };
    const result: AdminMutationResult = { ...committed, revision: saved.revision, snapshot: saved, application: saved.application };
    await prisma.$transaction(tx => completeReceipt(prismaQuery(tx), command, result));
    return result;
  }
  return committed;
}
