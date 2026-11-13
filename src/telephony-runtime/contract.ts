import { TenantDatabaseError } from "../tenant-database/error";

export const runtimeTables = [
	"telephony_runtime_policy",
	"telephony_operator_state",
	"telephony_calls",
	"telephony_call_events",
	"telephony_call_reviews",
	"telephony_pause_segments",
	"telephony_runtime_operations",
	"telephony_pbx_members",
	"telephony_pbx_intents",
	"operadores",
	"clientes",
	"campanhas_clientes",
	"motivos_pausa",
];
export const runtimeActions = [
	"status",
	"prepare",
	"event",
	"get",
	"list",
	"review",
	"pause",
	"metrics",
	"session",
	"pbx.pending",
	"pbx.result",
] as const;
export type RuntimeAction = (typeof runtimeActions)[number];
export interface RuntimeCommand {
	operation: "telephony.runtime";
	actorId: number;
	action: RuntimeAction;
	input: Record<string, unknown>;
}
export const fail = (code: string): never => {
	throw new TenantDatabaseError(`TENANT_TELEPHONY_${code}`);
};
export function integer(value: unknown, optional = false): number | null {
	if (optional && (value === null || value === undefined)) return null;
	if (
		!Number.isSafeInteger(value) ||
		Number(value) < 1 ||
		Number(value) > 2147483647
	)
		return fail("INVALID_REQUEST");
	return Number(value);
}
export function uuid(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
			value,
		)
	)
		return fail("INVALID_REQUEST");
	return value.toLowerCase();
}
export function databaseId(value:unknown):string{
  const id=typeof value==="number"&&Number.isSafeInteger(value)?String(value):value;
  if(typeof id!=="string"||!/^[1-9][0-9]{0,18}$/.test(id)||BigInt(id)>9223372036854775807n)return fail("INVALID_REQUEST");
  return id;
}
export function text(value: unknown, max: number, optional = false): string {
	if (optional && (value === undefined || value === null)) return "";
	if (
		typeof value !== "string" ||
		value.length > max ||
		/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) ||
		(!optional && !value.trim())
	)
		return fail("INVALID_REQUEST");
	return value.trim();
}
export function parseRuntimeCommand(value: unknown): RuntimeCommand {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return fail("INVALID_REQUEST");
	const command = value as Record<string, unknown>;
	if (
		Object.keys(command).some(
			(key) => !["operation", "actorId", "action", "input"].includes(key),
		) ||
		command["operation"] !== "telephony.runtime" ||
		!runtimeActions.includes(command["action"] as RuntimeAction) ||
		!command["input"] ||
		typeof command["input"] !== "object" ||
		Array.isArray(command["input"])
	)
		return fail("INVALID_REQUEST");
	return {
		operation: "telephony.runtime",
		actorId: integer(command["actorId"])!,
		action: command["action"] as RuntimeAction,
		input: command["input"] as Record<string, unknown>,
	};
}
