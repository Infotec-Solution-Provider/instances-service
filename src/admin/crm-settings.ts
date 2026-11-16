import { getTenantDatabase } from "../services/tenant-database.service";
import PoolsService from "../services/pools.service";
import { TenantDatabaseError } from "../tenant-database/error";
import { AdminCommand, AdminMutationResult, AdminProtocolError, AdminSetting, AdminSnapshot, opaqueRevision, requireRevision } from "./admin-protocol";
import { diff, Query, readReceipt, secretKey, snapshot, tenant, validateChanges, writeReceipt } from "./settings-utils";
import { crmParameterSettings } from "./crm-parameter-settings.metadata";

const crmMetadata = new Map(crmParameterSettings.map(setting => [setting.key, setting]));
/** Presentation only. The tenant schema still determines types, values and validation. */
export function applyCrmDisplayMetadata(setting: AdminSetting): AdminSetting {
  const known = crmMetadata.get(setting.key);
  if (!known) return setting;
  return { ...setting, label: known.label, description: known.description, category: known.group,
    ...(setting.options ? { options: setting.options.map(option => ({ ...option,
      label: known.type === "boolean" && option.value === known.trueValue ? "Ativado" :
        known.type === "boolean" && option.value === known.falseValue ? "Desativado" : option.label,
    })) } : {}),
  };
}

const sipGlobalFields = new Set(["ASTERISK_SERVER", "ASTERISK_PORTA", "ASTERISK_PROXY", "SIP_EMITE_BIP", "SIP_VOLUME_AUTOMATICO", "CALL_IN_DEVICE", "CALL_OUT_DEVICE", "RING_DEVICE", "IP_TELNET", "PORTA_TELNET", "USUARIO_TELNET", "SENHA_TELNET", "PAUSARRAMAL", "RAMALPAUSA", "RAMALDESPAUSA", "LIGACAO_IMEDIATA", "SIP_ID", "SIP_KEY", "GRAVAR_LIGACAO"]);
const sipUserFields = new Set(["RAMAL_SIP", "IP_SERVIDOR_SIP", "LOGIN_SIP", "SENHA_SIP", "USRID_SIP", "CODECS_SIP", "CFG_CONFIG_SIP"]);
const webFields = new Set(["enabled", "connection_mode", "websocket_url", "sip_domain", "pbx_address", "ice_servers_json"]);
interface Column { key: string; type: string; columnType: string; nullable: string; defaultValue: string | null; maxLength: number | null; extra: string }
const quote = (name: string) => `\`${name.replace(/`/g, "``")}\``;
export const crmSources = new Set(["crm", "sip-global", "sip-user", "webrtc"]);
const table = (source: string) => source === "sip-user" ? "operadores_config_sip" : source === "webrtc" ? "telephony_webrtc_settings" : "parametros";
function userId(command: AdminCommand): number {
  const id = command.target?.userId;
  if (!Number.isSafeInteger(id) || id! <= 0 || id! > 2147483647) throw new AdminProtocolError(400, "Selecione um operador do tenant alvo.");
  return id!;
}
/** Only positively identified schema/data absence is an unavailable capability. */
class CrmSettingsUnavailable extends AdminProtocolError {
  constructor(public readonly reason: "TABLE_MISSING" | "SCHEMA_UNSUPPORTED" | "INITIAL_ROW_MISSING", message: string) { super(503, message); }
}
function unavailableSnapshot(command: AdminCommand, error: CrmSettingsUnavailable): AdminSnapshot {
  return {
    source: command.source!, tenant: tenant(command), ...(command.target ? { target: command.target } : {}),
    revision: opaqueRevision({ environment: command.environment, tenant: command.tenant, source: command.source, target: command.target ?? null }, { available: false, reason: error.reason }),
    catalog: [], values: {}, secrets: {}, resources: [], unavailableReason: error.message,
  };
}
async function configurationSchema(command: AdminCommand, query: Query) {
  const source = command.source!, name = table(source);
  const columns = await query<Column[]>("SELECT COLUMN_NAME AS `key`,DATA_TYPE AS type,COLUMN_TYPE AS columnType,IS_NULLABLE AS nullable,COLUMN_DEFAULT AS defaultValue,CHARACTER_MAXIMUM_LENGTH AS maxLength,EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION", [name]);
  if (!columns.length) throw new CrmSettingsUnavailable("TABLE_MISSING", "Esta configuração não está habilitada no CRM deste tenant neste ambiente. Selecione outra configuração ou outro tenant.");
  const selected = columns.filter(column => source === "sip-global" ? sipGlobalFields.has(column.key) : source === "sip-user" ? sipUserFields.has(column.key) : source === "webrtc" ? webFields.has(column.key) : column.key !== "CODIGO" && !column.extra.includes("auto_increment") && !column.extra.includes("GENERATED"));
  const primary = source === "sip-user" ? "COD_CONFIG_SIP" : source === "webrtc" ? "id" : "CODIGO";
  const required = source === "sip-user" ? [primary, "COD_OPERADOR"] : [primary];
  if (!required.every(key => columns.some(column => column.key === key)) || !selected.length) throw new CrmSettingsUnavailable("SCHEMA_UNSUPPORTED", "O schema desta configuração ainda não é suportado para este tenant. Nenhum valor foi consultado ou alterado.");
  return { name, selected, primary };
}
async function current(command: AdminCommand, query: Query, lock = false) {
  const source = command.source!, { name, selected, primary } = await configurationSchema(command, query);
  if (source === "sip-user") {
    const users = await query<{ CODIGO: number }[]>(`SELECT CODIGO FROM operadores WHERE CODIGO=?${lock ? " FOR UPDATE" : ""}`, [userId(command)]);
    if (!users[0]) throw new AdminProtocolError(404, "Operador não encontrado no tenant alvo.");
  }
  const fields = [primary, ...selected.map(column => column.key)].map(quote).join(",");
  const where = source === "sip-user" ? " WHERE COD_OPERADOR=?" : source === "webrtc" ? " WHERE id=1" : "";
  const rows = await query<Record<string, unknown>[]>(`SELECT ${fields} FROM ${quote(name)}${where} ORDER BY ${quote(primary)} ASC LIMIT 1${lock ? " FOR UPDATE" : ""}`, source === "sip-user" ? [userId(command)] : []);
  if (!rows[0] && source !== "sip-user" && source !== "webrtc") throw new CrmSettingsUnavailable("INITIAL_ROW_MISSING", "Esta configuração ainda não possui registro inicial no CRM deste tenant. Nenhum registro será criado automaticamente.");
  const values = rows[0] ?? Object.fromEntries(selected.map(column => [column.key, column.defaultValue]));
  if (!rows[0] && source === "webrtc") Object.assign(values, { id: null, enabled: 0, connection_mode: "direct", websocket_url: "", sip_domain: "", pbx_address: "", ice_servers_json: "[]" });
  const catalog: AdminSetting[] = selected.map(column => {
    const options = column.type === "enum" ? [...column.columnType.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(match => ({ label: match[1]!, value: match[1]!.replace(/\\'/g, "'") })) : undefined;
    const numeric = /^(tinyint|smallint|mediumint|int|bigint|decimal|float|double)$/.test(column.type);
    const secret = secretKey(column.key) || column.key === "ice_servers_json" || column.key === "CFG_CONFIG_SIP";
    const setting: AdminSetting = { key: column.key, label: column.key, description: source === "crm" ? "Parâmetro do CRM legado. O valor é validado contra o schema deste tenant." : "Configuração técnica de telefonia.", category: source === "crm" ? "CRM legado" : "Telefonia", type: secret ? "secret" : options ? "enum" : numeric ? "number" : "string", ...(options ? { options } : {}), defaultValue: column.defaultValue, canReset: column.defaultValue !== null || column.nullable === "YES", applyMode: source === "sip-global" ? "reload" : "dynamic" };
    return source === "crm" ? applyCrmDisplayMetadata(setting) : setting;
  });
  return { columns: selected, state: values, catalog, primary, table: name, exists: !!rows[0] };
}
function preparedValue(value: unknown, column: Column): unknown {
  if (value === null) {
    if (column.nullable !== "YES") throw new AdminProtocolError(400, `${column.key}: não permite valor vazio.`);
    return null;
  }
  if (column.type === "json" || column.key === "ice_servers_json" || column.key === "CFG_CONFIG_SIP") {
    if (typeof value === "object") return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  }
  if (typeof value === "object" || value === undefined) throw new AdminProtocolError(400, `${column.key}: valor inválido.`);
  if (/^(tinyint|smallint|mediumint|int|bigint)$/.test(column.type) && (!/^-?\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)))) throw new AdminProtocolError(400, `${column.key}: informe um inteiro válido.`);
  if (column.maxLength !== null && String(value).length > Number(column.maxLength)) throw new AdminProtocolError(400, `${column.key}: texto excede o tamanho permitido.`);
  return value;
}
function validateWebrtc(state: Record<string, unknown>): void {
  const enabled = Number(state["enabled"]) === 1;
  if (![0, 1].includes(Number(state["enabled"])) || !["direct", "gateway"].includes(String(state["connection_mode"]))) throw new AdminProtocolError(400, "Modo ou ativação WebRTC inválidos.");
  if (enabled && state["connection_mode"] === "direct") {
    try { const url = new URL(String(state["websocket_url"])); if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || !state["sip_domain"]) throw new Error(); }
    catch { throw new AdminProtocolError(400, "Configure o WebSocket SIP e o domínio antes de habilitar WebRTC."); }
  }
  if (enabled && state["connection_mode"] === "gateway" && !state["pbx_address"]) throw new AdminProtocolError(400, "Configure o endereço PBX antes de habilitar o gateway.");
  try {
    const servers = typeof state["ice_servers_json"] === "string" ? JSON.parse(state["ice_servers_json"]) as unknown : state["ice_servers_json"];
    if (!Array.isArray(servers) || servers.length > 20 || servers.some(server => !server || typeof server !== "object" || !Array.isArray(server.urls) || !server.urls.length || server.urls.some((url: unknown) => typeof url !== "string" || !/^(stun|stuns|turn|turns):/.test(url)))) throw new Error();
  } catch { throw new AdminProtocolError(400, "Informe uma lista ICE válida com urls STUN/TURN."); }
}
export async function crmSettings(command: AdminCommand): Promise<unknown> {
  if (!crmSources.has(command.source ?? "")) throw new AdminProtocolError(400, "Fonte CRM inválida.");
  try { return await executeCrmSettings(command); }
  catch (error) {
    if (error instanceof CrmSettingsUnavailable) {
      if (command.action === "getSettings") return unavailableSnapshot(command, error);
      if (command.action === "getTargets") return { targets: [], hasMore: false, unavailableReason: error.message };
    }
    throw error;
  }
}
async function executeCrmSettings(command: AdminCommand): Promise<unknown> {
  const read: Query = async <T>(sql: string, params: unknown[] = []) => PoolsService.query(tenant(command), sql, params, { retryOnConnectionLoss: false }) as Promise<T>;
  if (command.action === "getReceipt") return await readReceipt(read, command) ?? { found: false };
  if (command.action === "getTargets" && command.source === "sip-user") {
    const search = command.search ?? "";
    if (search.length > 100) throw new AdminProtocolError(400, "Busca muito extensa.");
    await configurationSchema(command, read);
    const rows = await read<{ id: number; label: string; active: string }[]>("SELECT CODIGO AS id,NOME AS label,ATIVO AS active FROM operadores WHERE (LOCATE(?,NOME)>0 OR CAST(CODIGO AS CHAR)=?) ORDER BY NOME,CODIGO LIMIT 50", [search, search]);
    return { targets: rows.map(row => ({ ...row, active: row.active === "SIM" })) };
  }
  if (command.action === "getSettings") {
    const saved = await current(command, read);
    return snapshot(command, saved.state, saved.catalog, { state: command.source === "sip-global" ? "unknown" : "applied" });
  }
  if (command.action !== "saveSettings") throw new AdminProtocolError(400, "Aplique AMI pelo serviço de telefonia; demais parâmetros são carregados dinamicamente.");
  let validationError: AdminProtocolError | undefined;
  try {
    return await getTenantDatabase().transaction(tenant(command), "admin-config", [table(command.source!), "admin_operation_receipts", ...(command.source === "sip-user" ? ["operadores"] : [])], async tx => {
      const query: Query = (sql, params) => tx.execute(sql, params);
      try {
        const existing = await readReceipt(query, command, true);
        if (existing) return existing;
        const before = await current(command, query, true);
        requireRevision(command.revision, snapshot(command, before.state, before.catalog).revision);
        const changes = validateChanges(command, before.catalog);
        const after = { ...before.state };
        const prepared = changes.map(change => {
          const column = before.columns.find(item => item.key === change.key)!;
          const value = change.action === "reset" ? column.defaultValue : change.action === "remove" ? null : preparedValue(change.value, column);
          if (change.action === "remove" && column.nullable !== "YES") throw new AdminProtocolError(400, `${column.key}: não permite remoção.`);
          after[change.key] = value;
          return { ...change, value };
        });
        if (command.source === "webrtc") validateWebrtc(after);
        if (before.exists) {
          const clauses = prepared.map(change => `${quote(change.key)}=${change.action === "reset" ? "DEFAULT" : "?"}`).join(",");
          await query(`UPDATE ${quote(before.table)} SET ${clauses} WHERE ${quote(before.primary)}=?`, [...prepared.filter(change => change.action !== "reset").map(change => change.value), before.state[before.primary]]);
        } else if (command.source === "sip-user") {
          const latest = await query<{ id: number }[]>("SELECT COD_CONFIG_SIP AS id FROM operadores_config_sip ORDER BY COD_CONFIG_SIP DESC LIMIT 1 FOR UPDATE");
          const values = Object.fromEntries(before.columns.map(column => [column.key, after[column.key] ?? null]));
          const keys = Object.keys(values);
          await query(`INSERT INTO operadores_config_sip (COD_CONFIG_SIP,COD_OPERADOR,${keys.map(quote).join(",")}) VALUES (${Array(keys.length + 2).fill("?").join(",")})`, [(Number(latest[0]?.id) || 0) + 1, userId(command), ...keys.map(key => values[key])]);
        } else {
          const keys = Object.keys(after).filter(key => webFields.has(key));
          await query(`INSERT INTO telephony_webrtc_settings (id,updated_by,${keys.map(quote).join(",")}) VALUES (1,0,${keys.map(() => "?").join(",")})`, keys.map(key => after[key]));
        }
        const stored = await current(command, query);
        const saved = snapshot(command, stored.state, stored.catalog, { state: command.source === "sip-global" ? "pending" : "applied", ...(command.source === "sip-global" ? { message: "Credenciais salvas. A conexão AMI deve ser reaplicada separadamente." } : {}) });
        const result: AdminMutationResult = { operationId: command.operationId!, state: "COMMITTED", revision: saved.revision, snapshot: saved, changes: diff(changes, before.state, stored.state, before.catalog), application: saved.application! };
        await writeReceipt(query, command, result);
        return result;
      } catch (error) {
        if (error instanceof AdminProtocolError) { validationError = error; throw new TenantDatabaseError("ADMIN_CONFIG_REJECTED"); }
        throw error;
      }
    });
  } catch (error) {
    if (validationError && !(error instanceof TenantDatabaseError && error.outcome === "UNKNOWN")) throw validationError;
    throw new AdminProtocolError(503, "Não foi possível confirmar a alteração CRM. Consulte o recibo da operação antes de tentar novamente.");
  }
}
