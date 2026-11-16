import type { TenantDatabase } from "../tenant-database/tenant-database";
import type { TenantTransaction } from "../tenant-database/transaction";
import { TenantDatabaseError } from "../tenant-database/error";

export type PauseScope = "telephony" | "all_channels";
export function pausePolicyScope(policy: Record<string, unknown> | undefined, storageReady = false) {
  const requestedScope: PauseScope = Number(policy?.["pause_all_channels"]) === 1 ? "all_channels" : "telephony";
  const revision = String(policy?.["preflight_hash"] || "");
  return {
    scope: "telephony" as PauseScope, requestedScope,
    scopeReady: requestedScope === "telephony",
    scopeStorageReady: requestedScope === "telephony" || storageReady,
    policyRevision: /^[a-f0-9]{64}$/i.test(revision) ? revision : null,
    afterAttendanceScope: "telephony_schedule" as const,
    channels: {
      telephony: { supported: true, enforced: true },
      whatsapp: { supported: false, enforced: false, reason: requestedScope === "all_channels" ? "verification_required" : "not_enabled" },
    },
  };
}
export async function pauseCutoffColumn(tx: TenantTransaction): Promise<{present: boolean; fractional: boolean}> {
  const columns = await tx.execute<Array<Record<string, unknown>>>("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='telephony_operator_state' AND COLUMN_NAME='unavailable_since'", []);
  return { present: columns.length === 1, fractional: /^datetime\([3-6]\)$/i.test(String(columns[0]?.["COLUMN_TYPE"] || "")) };
}
export async function pauseCutoffAvailable(tx: TenantTransaction): Promise<boolean> {
  return (await pauseCutoffColumn(tx)).present;
}
export function semanticPauseInput(input: Record<string, unknown>) {
  // Server verification is not part of the user's idempotency key/content.
  const { scopePolicyRevision: _revision, scopeVerified: _verified, ...semantic } = input;
  return semantic;
}
export interface PauseEligibilityCommand { operation: "operator.pause.eligibility"; actorIds: number[] }
export function parsePauseEligibility(value: unknown): PauseEligibilityCommand {
  const invalid = (): never => { throw new TenantDatabaseError("TENANT_TRANSACTION_INVALID_REQUEST"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
  if (input["operation"] !== "operator.pause.eligibility" || Object.keys(input).some(k => !["operation", "actorIds"].includes(k)) || !Array.isArray(input["actorIds"]) || !input["actorIds"].length || input["actorIds"].length > 200 || input["actorIds"].some(id => !Number.isSafeInteger(id) || id < 1 || id > 2147483647)) return invalid();
  return { operation: "operator.pause.eligibility", actorIds: [...new Set(input["actorIds"] as number[])].sort((a, b) => a - b) };
}
export async function operatorPauseEligibility(database: Pick<TenantDatabase, "transaction">, tenant: string, command: PauseEligibilityCommand) {
  const present = await database.transaction(tenant, "operator.pause.discovery", ["operadores"], tx => tx.execute<Array<{ TABLE_NAME: string }>>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='telephony_runtime_policy'"));
  return database.transaction(tenant, command.operation, present.length ? ["operadores", "telephony_runtime_policy", "telephony_operator_state"] : ["operadores"], async (tx: TenantTransaction) => {
    const policy = present.length ? (await tx.execute<Array<Record<string, unknown>>>("SELECT * FROM telephony_runtime_policy WHERE id=1"))[0] : undefined;
    const all = Number(policy?.["pause_all_channels"]) === 1;
    const scope = pausePolicyScope(policy);
    if (all && (Number(policy?.["enabled"]) !== 1 || !scope.policyRevision || !(await pauseCutoffAvailable(tx)))) throw new TenantDatabaseError("TENANT_OPERATOR_PAUSE_POLICY_UNAVAILABLE");
    const ids = command.actorIds;
    const rows = await tx.execute<Array<Record<string, unknown>>>(present.length
      ? `SELECT o.CODIGO,o.ATIVO,s.state,s.version FROM operadores o LEFT JOIN telephony_operator_state s ON s.operator_id=o.CODIGO WHERE o.CODIGO IN (${ids.map(() => "?").join(",")}) ORDER BY o.CODIGO`
      : `SELECT CODIGO,ATIVO FROM operadores WHERE CODIGO IN (${ids.map(() => "?").join(",")}) ORDER BY CODIGO`, ids);
    return {
      requestedScope: scope.requestedScope, policyRevision: scope.policyRevision, advisory: true,
      entries: ids.map(actorId => {
        const row = rows.find(r => Number(r["CODIGO"]) === actorId);
        const active = row?.["ATIVO"] === "SIM";
        const state = row?.["state"] == null ? "available" : String(row["state"]);
        const known = ["available", "pending", "paused"].includes(state);
        return { actorId, active, state: known ? state : "unknown", version: Number(row?.["version"] || 0), newAssignmentsAllowed: active && (!all || (known && state === "available")) };
      }),
    };
  });
}
