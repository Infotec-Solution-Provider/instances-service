import {
	AdministrationFault,
	checkSchema,
	checkTransferSchema,
	hash,
	readSnapshot,
	snapshotVersion,
	transferEffects,
	transferTables,
} from "./administration-snapshot";
import { TenantDatabaseError } from "./error";
import type { TenantTransaction } from "./transaction";
export { transferTables };
export interface TransferCommand {
	operation: "crm.administration.transfer";
	operationId: string;
	actorId: number;
	source: number;
	destination: number;
	customerIds: number[];
	version: string;
}
export function parseTransfer(value: unknown): TransferCommand {
	const invalid = (): never => {
		throw new TenantDatabaseError("TENANT_TRANSACTION_INVALID_REQUEST");
	};
	if (!value || typeof value !== "object" || Array.isArray(value))
		return invalid();
	const body = value as Record<string, unknown>;
	const positive = (id: unknown) =>
		typeof id === "number" &&
		Number.isInteger(id) &&
		id > 0 &&
		id <= 2147483647;
	if (
		Object.keys(body).some(
			(key) =>
				![
					"operation",
					"operationId",
					"actorId",
					"source",
					"destination",
					"customerIds",
					"version",
				].includes(key),
		) ||
		body["operation"] !== "crm.administration.transfer" ||
		typeof body["operationId"] !== "string" ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
			body["operationId"],
		) ||
		typeof body["version"] !== "string" ||
		!/^[a-f0-9]{64}$/.test(body["version"]) ||
		!positive(body["actorId"]) ||
		!positive(body["source"]) ||
		!positive(body["destination"]) ||
		body["source"] === body["destination"] ||
		!Array.isArray(body["customerIds"]) ||
		!body["customerIds"].length ||
		body["customerIds"].length > 100 ||
		body["customerIds"].some((id) => !positive(id)) ||
		new Set(body["customerIds"]).size !== body["customerIds"].length
	)
		return invalid();
	return {
		operation: "crm.administration.transfer",
		operationId: String(body["operationId"]),
		actorId: Number(body["actorId"]),
		source: Number(body["source"]),
		destination: Number(body["destination"]),
		customerIds: [...body["customerIds"]].sort((a, b) => a - b),
		version: String(body["version"]),
	};
}
/** Structured, signed repository command. No SQL, tables or actor from an end-user request. */
export async function transferCustomers(
	tx: TenantTransaction,
	input: TransferCommand,
) {
	try {
		await checkTransferSchema(tx.execute);
		const triggers = await tx.execute<unknown[]>(
			`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN (${transferTables.map(() => "?").join(",")}) LIMIT 1`,
			transferTables,
		);
		if (triggers.length)
			throw new AdministrationFault("TRIGGERS_UNSUPPORTED");
		// Serialize on operators in a stable order before locking the receipt and selected customers/ranges.
		let actorSector: number | null = null;
		if (tx.tenant === "nunes") {
			await checkSchema(tx.execute, { operadores: ["CODIGO", "SETOR"] });
			const operators = await tx.execute<
				{ CODIGO: number; SETOR: number | null }[]
			>(
				"SELECT CODIGO,SETOR FROM operadores WHERE CODIGO IN (?,?,?) ORDER BY CODIGO FOR UPDATE",
				[input.source, input.destination, input.actorId].sort(
					(a, b) => a - b,
				),
			);
			const actor = operators.find(
				(row) => Number(row.CODIGO) === input.actorId,
			);
			if (
				!actor ||
				!Number.isInteger(Number(actor.SETOR)) ||
				Number(actor.SETOR) < 1
			)
				throw new AdministrationFault("FORBIDDEN");
			actorSector = Number(actor.SETOR);
		} else
			await tx.execute(
				"SELECT CODIGO FROM operadores WHERE CODIGO IN (?,?) ORDER BY CODIGO FOR UPDATE",
				[input.source, input.destination].sort((a, b) => a - b),
			);
		const requestHash = hash(input);
		const receipts = await tx.execute<
			{ request_hash: string; transfer_id: number }[]
		>(
			"SELECT request_hash,transfer_id FROM crm_administration_transfers WHERE operation_id=? FOR UPDATE",
			[input.operationId],
		);
		if (receipts.length) {
			if (receipts[0]!.request_hash !== requestHash)
				throw new AdministrationFault("OPERATION_CONFLICT");
			return {
				operationId: input.operationId,
				transferId: receipts[0]!.transfer_id,
				status: "applied",
			};
		}
		const snapshot = await readSnapshot(
			tx.execute,
			tx.tenant,
			input.customerIds,
			input.source,
			input.destination,
			true,
		);
		if (
			actorSector !== null &&
			actorSector !== 3 &&
			snapshot.customers.some(
				(row) => Number(row["SETOR"]) !== actorSector,
			)
		)
			throw new AdministrationFault("FORBIDDEN");
		if (
			snapshotVersion(
				tx.tenant,
				input.customerIds,
				input.source,
				input.destination,
				snapshot,
			) !== input.version
		)
			throw new AdministrationFault("SELECTION_CHANGED");
		const effects = transferEffects(
			snapshot,
			tx.tenant,
			input.source,
			input.destination,
		);
		if (effects.reasons.length)
			throw new AdministrationFault(effects.reasons[0]!);
		const mutate = async (
			sql: string,
			params: unknown[],
			expected: number,
		) => {
			const result = await tx.execute<{
				affectedRows: number;
				insertId: number;
			}>(sql, params);
			if (result.affectedRows !== expected)
				throw new AdministrationFault("SELECTION_CHANGED");
			return result;
		};
		const transfer = await mutate(
			"INSERT INTO transferencia_clientes (DATA_HORA,OPERADOR,OPERADOR_ORIGEM,OPERADOR_DESTINO) VALUES (@inpulse_crm_transfer_at,?,?,?)",
			[input.actorId, input.source, input.destination],
			1,
		);
		if (!Number.isSafeInteger(transfer.insertId) || transfer.insertId < 1)
			throw new AdministrationFault("SCHEMA_UNSUPPORTED");
		await mutate(
			`INSERT INTO transferencia_clientes_itens (CODIGO,CLIENTE) VALUES ${input.customerIds.map(() => "(?,?)").join(",")}`,
			input.customerIds.flatMap((id) => [transfer.insertId, id]),
			input.customerIds.length,
		);
		for (const [table, field, rows] of [
			["clientes", "OPERADOR", effects.customers],
			["campanhas_clientes", "OPERADOR", effects.schedules],
			["fidelizacoes", "OPERADOR_CRIACAO", effects.loyalties],
		] as const) {
			if (rows.length)
				await mutate(
					`UPDATE \`${table}\` SET \`${field}\`=? WHERE CODIGO IN (${rows.map(() => "?").join(",")}) AND \`${field}\`=?`,
					[
						input.destination,
						...rows.map((row) => Number(row["CODIGO"])),
						input.source,
					],
					rows.length,
				);
		}
		await mutate(
			"INSERT INTO crm_administration_transfers (operation_id,request_hash,actor_id,transfer_id,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP())",
			[
				input.operationId,
				requestHash,
				input.actorId,
				transfer.insertId,
				JSON.stringify(snapshot),
				JSON.stringify({
					source: input.source,
					destination: input.destination,
					customers: effects.customers.map((r) => r["CODIGO"]),
					schedules: effects.schedules.map((r) => r["CODIGO"]),
					loyalties: effects.loyalties.map((r) => r["CODIGO"]),
				}),
			],
			1,
		);
		return {
			operationId: input.operationId,
			transferId: transfer.insertId,
			status: "applied",
		};
	} catch (error) {
		if (error instanceof AdministrationFault)
			throw new TenantDatabaseError(
				`TENANT_ADMINISTRATION_${error.code}`,
			);
		throw error;
	}
}
