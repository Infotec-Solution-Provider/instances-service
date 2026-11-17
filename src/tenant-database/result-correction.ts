import { TenantDatabaseError } from "./error";
import type { TenantTransaction } from "./transaction";

export const resultCorrectionTables = [
	"campanhas_clientes",
	"clientes",
	"operadores",
	"resultados",
	"propostas",
	"campanhas_clientes_log",
];
export interface ResultCorrection {
	operation: "crm.schedule.correct-result";
	scheduleId: number;
	actorId: number;
	oldResult: number;
	newResult: number;
	proposalCount: number;
}
export function parseResultCorrection(value: unknown): ResultCorrection {
	const invalid = (): never => {
		throw new TenantDatabaseError("TENANT_TRANSACTION_INVALID_REQUEST");
	};
	if (!value || typeof value !== "object" || Array.isArray(value))
		return invalid();
	const v = value as Record<string, unknown>;
	if (
		Object.keys(v).some(
			(k) =>
				![
					"operation",
					"scheduleId",
					"actorId",
					"oldResult",
					"newResult",
					"proposalCount",
				].includes(k),
		) ||
		v["operation"] !== "crm.schedule.correct-result"
	)
		return invalid();
	for (const k of [
		"scheduleId",
		"actorId",
		"oldResult",
		"newResult",
		"proposalCount",
	]) {
		if (
			typeof v[k] !== "number" ||
			!Number.isSafeInteger(v[k]) ||
			Number(v[k]) <
				(k === "oldResult"
					? -2147483648
					: k === "proposalCount"
						? 0
						: 1) ||
			Number(v[k]) > 2147483647
		)
			return invalid();
	}
	if (v["oldResult"] === v["newResult"]) return invalid();
	return v as unknown as ResultCorrection;
}
export async function correctScheduleResult(
	tx: TenantTransaction,
	input: ResultCorrection,
) {
	const conflict = (): never => {
		throw new TenantDatabaseError("TENANT_RESULT_CORRECTION_CHANGED");
	};
	const triggers = await tx.execute<unknown[]>(
		"SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN ('campanhas_clientes','propostas','campanhas_clientes_log') LIMIT 1",
	);
	if (triggers.length)
		throw new TenantDatabaseError("TENANT_TRANSACTION_UNREVIEWED_TRIGGERS");
	const actor = await tx.execute<
		{ ATIVO: string; NIVEL: string; SETOR: number }[]
	>(`SELECT ATIVO,NIVEL,${tx.tenant === "nunes" ? "SETOR" : "NULL AS SETOR"} FROM operadores WHERE CODIGO=? FOR UPDATE`, [
		input.actorId,
	]);
	if (
		!actor.length ||
		actor[0]!.ATIVO !== "SIM" ||
		actor[0]!.NIVEL !== "ADMIN"
	)
		throw new TenantDatabaseError("TENANT_RESULT_CORRECTION_FORBIDDEN");
	const schedules = await tx.execute<
		{ RESULTADO: number; CONCLUIDO: string; SETOR: number }[]
	>(
		`SELECT cc.RESULTADO,cc.CONCLUIDO,${tx.tenant === "nunes" ? "c.SETOR" : "NULL AS SETOR"} FROM campanhas_clientes cc INNER JOIN clientes c ON c.CODIGO=cc.CLIENTE WHERE cc.CODIGO=? FOR UPDATE`,
		[input.scheduleId],
	);
	const row = schedules[0];
	if (
		!row ||
		row.CONCLUIDO !== "SIM" ||
		Number(row.RESULTADO) !== input.oldResult
	)
		return conflict();
	if (
		tx.tenant === "nunes" &&
		(Number(actor[0]!.SETOR) < 1 ||
			(Number(actor[0]!.SETOR) !== 3 &&
				Number(actor[0]!.SETOR) !== Number(row.SETOR)))
	)
		throw new TenantDatabaseError("TENANT_RESULT_CORRECTION_FORBIDDEN");
	const results = await tx.execute<unknown[]>(
		"SELECT CODIGO FROM resultados WHERE CODIGO=? AND CODIGO>0 FOR UPDATE",
		[input.newResult],
	);
	if (results.length !== 1) return conflict();
	// Cascades can mutate tables outside this transaction's declared engine checks.
	const cascades = await tx.execute<unknown[]>(
		"SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE REFERENCED_TABLE_NAME='propostas' AND UNIQUE_CONSTRAINT_SCHEMA=DATABASE() AND DELETE_RULE IN ('CASCADE','SET NULL') LIMIT 1",
	);
	if (cascades.length)
		throw new TenantDatabaseError(
			"TENANT_RESULT_CORRECTION_UNREVIEWED_REFERENCES",
		);
	const proposals = await tx.execute<unknown[]>(
		"SELECT CODIGO FROM propostas WHERE LIGACAO=? FOR UPDATE",
		[input.scheduleId],
	);
	if (proposals.length !== input.proposalCount) return conflict();
	const updated = await tx.execute<{ affectedRows: number }>(
		"UPDATE campanhas_clientes SET RESULTADO=? WHERE CODIGO=? AND CONCLUIDO='SIM' AND RESULTADO=?",
		[input.newResult, input.scheduleId, input.oldResult],
	);
	if (updated.affectedRows !== 1) return conflict();
	const deleted = await tx.execute<{ affectedRows: number }>(
		"DELETE FROM propostas WHERE LIGACAO=?",
		[input.scheduleId],
	);
	if (deleted.affectedRows !== input.proposalCount) return conflict();
	const logged = await tx.execute<{ affectedRows: number }>(
		"INSERT INTO campanhas_clientes_log (codigo,data_hora,operador,campo,old_valor,new_valor,modulo) VALUES (?,@inpulse_crm_transfer_at,?,'RESULTADO',?,?,'WEB')",
		[
			input.scheduleId,
			input.actorId,
			String(input.oldResult),
			String(input.newResult),
		],
	);
	if (logged.affectedRows !== 1) return conflict();
	return {
		scheduleId: input.scheduleId,
		resultId: input.newResult,
		removedProposals: deleted.affectedRows,
	};
}
