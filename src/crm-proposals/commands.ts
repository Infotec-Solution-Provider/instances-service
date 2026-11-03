import { TenantDatabaseError } from "../tenant-database/error";
import {
	cancelSql,
	changeValueSql,
	deleteSql,
	eventSql,
	createSql,
	createEventSql,
	finishCancelSql,
	proposalTables,
} from "./sql";

const invalid = (): never => {
	throw new TenantDatabaseError("TENANT_TRANSACTION_INVALID_REQUEST");
};
export function proposalBatch(batch: Record<string, unknown>) {
	if (
		Object.keys(batch).some(
			(k) =>
				!["operation", "scheduleId", "tables", "statements"].includes(
					k,
				),
		) ||
		!Number.isInteger(batch["scheduleId"]) ||
		Number(batch["scheduleId"]) < 1 ||
		Number(batch["scheduleId"]) > 2147483647 ||
		!Array.isArray(batch["tables"]) ||
		batch["tables"].length !== proposalTables.length ||
		proposalTables.some(
			(t) => !(batch["tables"] as unknown[]).includes(t),
		) ||
		!Array.isArray(batch["statements"]) ||
		batch["statements"].length !== 2
	)
		return invalid();
	const statements = batch["statements"].map((s: unknown, i: number) =>
		checkProposalStatement(
			s,
			i === 0 ? [changeValueSql, cancelSql, deleteSql] : [eventSql],
		),
	);
	const event = statements[1]!;
	const mutation = statements[0]!;
	const offset = mutation.sql === changeValueSql ? 1 : 0;
	if (
		event.params[2] !== mutation.params[offset] ||
		event.params[3] !== batch["scheduleId"] ||
		mutation.params[offset + 1] !== batch["scheduleId"] ||
		event.params[4] !== mutation.params[offset + 4] ||
		event.params[6] !== mutation.params[offset + 2] ||
		event.params[8] !== mutation.params[offset + 3] ||
		event.params[5] !==
			(offset
				? "UPDATE"
				: mutation.sql === cancelSql
					? "CANCEL"
					: "DELETE")
	)
		return invalid();
	return {
		operation: "crm.proposal.change",
		scheduleId: Number(batch["scheduleId"]),
		tables: proposalTables,
		statements,
	};
}
export function checkProposalStatement(value: unknown, templates: string[]) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return invalid();
	const s = value as Record<string, unknown>;
	if (
		Object.keys(s).some(
			(k) => !["sql", "params", "expectAffectedRows"].includes(k),
		) ||
		typeof s["sql"] !== "string" ||
		!templates.includes(s["sql"]) ||
		s["expectAffectedRows"] !== 1 ||
		!Array.isArray(s["params"]) ||
		s["params"].length !== (s["sql"].match(/\?/g) ?? []).length ||
		s["params"].some(
			(p) =>
				p !== null &&
				!(typeof p === "string" && p.length <= 1000) &&
				!(typeof p === "number" && Number.isSafeInteger(p)),
		)
	)
		return invalid();
	return {
		sql: s["sql"],
		params: s["params"] as (string | number | boolean | null)[],
		expectAffectedRows: 1,
	};
}
export function finishProposalStatements(
	statements: unknown[],
	scheduleId: number,
) {
	if (
		statements.length < 2 ||
		statements.length > 42 ||
		statements.length % 2
	)
		return invalid();
	const result = [];
	for (let i = 0; i < statements.length; i += 2) {
		const mutation = checkProposalStatement(statements[i], [
			createSql,
			finishCancelSql,
		]);
		const audit = checkProposalStatement(
			statements[i + 1],
			mutation.sql === createSql ? [createEventSql] : [eventSql],
		);
		if (mutation.sql === createSql) {
			if (
				i !== 0 ||
				mutation.params[0] !== scheduleId ||
				mutation.params[2] !== scheduleId ||
				audit.params[3] !== scheduleId
			)
				return invalid();
		} else if (
			mutation.params[4] !== scheduleId ||
			audit.params[2] !== mutation.params[0] ||
			audit.params[3] !== mutation.params[1] ||
			audit.params[4] !== mutation.params[5] ||
			audit.params[5] !== "CANCEL"
		)
			return invalid();
		result.push(mutation, audit);
	}
	return result;
}
