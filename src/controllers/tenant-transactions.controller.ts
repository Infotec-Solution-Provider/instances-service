import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { getTenantDatabase } from "../services/tenant-database.service";
import { TenantDatabaseError } from "../tenant-database/error";
import type { TenantDatabase } from "../tenant-database/tenant-database";
import { synchronizeCustomerPhones } from "../services/customer-phone-sync";
import { validateSatisfactionEffects } from "../services/satisfaction-effect";
import {
	parseImportReceipt,
	findImportReceipt,
	writeImportReceipt,
	type CustomerImportReceipt,
} from "../services/customer-import-receipt";
import {
	proposalBatch,
	finishProposalStatements,
} from "../crm-proposals/commands";
import { proposalTables, eventSql, deleteSql } from "../crm-proposals/sql";
import {
	parseTransfer,
	transferCustomers,
	transferTables,
} from "../tenant-database/administration-transfer";

const allowedTables = new Set([
	"campanhas_clientes",
	"telephony_schedule_edits",
	"clientes",
	"operadores",
	"campanhas_clientes_validade",
]);
const requiredTables = [
	"campanhas_clientes",
	"telephony_schedule_edits",
	"clientes",
	"operadores",
];
const generationTables = [
	"campanhas",
	"campanhas_clientes",
	"clientes",
	"operadores",
	"excecoes",
	"excecoes_cidade",
	"excecoes_estado",
	"excecoes_segmentos",
];
const finishTables = [
	"campanhas_clientes",
	"historico_cli",
	"telephony_schedule_finishes",
	"resultados",
	"operadores",
];
const surveyTables = [
	"pesquisa_satisfacao",
	"pesquisa_satisfacao_avaliacao",
	"telephony_satisfaction_submissions",
];
const windowMs = 60_000;
interface Statement {
	sql: string;
	params: (string | number | boolean | null)[];
	expectAffectedRows: number;
}
interface Batch {
	operation: string;
	campaignId?: number;
	scheduleId?: number;
	customerId?: number;
	syncPhones?: boolean;
	importReceipt?: CustomerImportReceipt;
	questionId?: number;
	surveyQuestions?: { id: number; description: string }[];
	tables: string[];
	statements: Statement[];
}

function customerBatch(batch: Record<string, unknown>): Batch {
	const invalid = (): never => {
		throw new TenantDatabaseError("TENANT_TRANSACTION_INVALID_REQUEST");
	};
	const receipt =
		batch["importReceipt"] === undefined
			? undefined
			: parseImportReceipt(batch["importReceipt"]);
	const permitted = new Set([
		"clientes",
		"parametros",
		"motivo_desativacao_cliente",
		"operadores",
		"grupos",
		"origens_sgr",
		"midias",
		"unidades",
		"segmentos",
		"campanhas",
		"uf",
		"fones_campanha_cli",
		...(receipt ? ["crm_import_receipts"] : []),
	]);
	if (
		Object.keys(batch).some(
			(key) =>
				![
					"operation",
					"customerId",
					"syncPhones",
					"importReceipt",
					"tables",
					"statements",
				].includes(key),
		) ||
		!Number.isInteger(batch["customerId"]) ||
		Number(batch["customerId"]) < 0 ||
		Number(batch["customerId"]) > 2147483647 ||
		!Array.isArray(batch["tables"]) ||
		batch["tables"].length > permitted.size ||
		batch["tables"].some((table) => !permitted.has(table)) ||
		!["clientes", "parametros"].every((table) =>
			(batch["tables"] as unknown[]).includes(table),
		) ||
		!Array.isArray(batch["statements"]) ||
		batch["statements"].length < 1 ||
		batch["statements"].length > 2
	)
		return invalid();
	if (
		receipt &&
		(batch["customerId"] !== 0 ||
			batch["syncPhones"] !== true ||
			batch["statements"].length !== 1 ||
			!["crm_import_receipts", "operadores"].every((table) =>
				(batch["tables"] as unknown[]).includes(table),
			))
	)
		return invalid();
	if (
		(batch["syncPhones"] !== undefined && batch["syncPhones"] !== true) ||
		(batch["tables"] as string[]).includes("fones_campanha_cli") !==
			(batch["syncPhones"] === true)
	)
		return invalid();
	const statements = batch["statements"].map(
		(input: unknown, index: number): Statement => {
			if (!input || typeof input !== "object" || Array.isArray(input))
				return invalid();
			const data = input as Record<string, unknown>,
				sql = data["sql"],
				params = data["params"];
			if (
				Object.keys(data).some(
					(key) =>
						!["sql", "params", "expectAffectedRows"].includes(key),
				) ||
				typeof sql !== "string" ||
				Buffer.byteLength(sql) > 65536 ||
				/;|--|\/\*|#/.test(sql) ||
				!(
					index === 0
						? Number(batch["customerId"]) === 0
							? /^INSERT INTO `?clientes`?\s*\(/i
							: /^UPDATE `?clientes`?\s/i
						: /^INSERT INTO `?motivo_desativacao_cliente`?\s*\(/i
				).test(sql) ||
				!Array.isArray(params) ||
				params.length > 200 ||
				params.some(
					(value) =>
						value !== null &&
						typeof value !== "string" &&
						typeof value !== "boolean" &&
						!(typeof value === "number" && Number.isFinite(value)),
				) ||
				(index === 0
					? data["expectAffectedRows"] !== 1
					: ![0, 1].includes(Number(data["expectAffectedRows"])))
			)
				return invalid();
			if (
				index === 1 &&
				!(batch["tables"] as unknown[]).includes(
					"motivo_desativacao_cliente",
				)
			)
				return invalid();
			return {
				sql,
				params,
				expectAffectedRows: Number(data["expectAffectedRows"]),
			};
		},
	);
	if (
		!batch["syncPhones"] &&
		(Number(batch["customerId"]) === 0 ||
			/\b(?:AREA[123]|AREAFAX|FONE[123]|FAX|DESC_FONE[123]|DESCFAX|OBS_FONE[123]|OBS_FAX)`?\s*=/i.test(
				statements[0]!.sql,
			))
	)
		return invalid();
	return {
		operation: "crm.customer.write",
		customerId: Number(batch["customerId"]),
		syncPhones: batch["syncPhones"] === true,
		...(receipt ? { importReceipt: receipt } : {}),
		tables: [...new Set(batch["tables"] as string[])],
		statements,
	};
}

function questionBatch(batch: Record<string, unknown>): Batch {
	const invalid = (): never => {
		throw new TenantDatabaseError("TENANT_TRANSACTION_INVALID_REQUEST");
	};
	if (
		Object.keys(batch).some(
			(k) =>
				!["operation", "questionId", "tables", "statements"].includes(
					k,
				),
		) ||
		!Number.isInteger(batch["questionId"]) ||
		Number(batch["questionId"]) < 0 ||
		Number(batch["questionId"]) > 2147483647 ||
		!Array.isArray(batch["tables"]) ||
		batch["tables"].length !== 2 ||
		!["pesquisa_satisfacao", "pesquisa_satisfacao_avaliacao"].every(
			(table) => (batch["tables"] as unknown[]).includes(table),
		) ||
		!Array.isArray(batch["statements"]) ||
		batch["statements"].length !== 1
	)
		return invalid();
	const statement = batch["statements"][0];
	if (
		!statement ||
		typeof statement !== "object" ||
		Object.keys(statement).some(
			(k) => !["sql", "params", "expectAffectedRows"].includes(k),
		) ||
		typeof statement.sql !== "string" ||
		statement.sql.length > 4096 ||
		/;|--|\/\*|#/.test(statement.sql) ||
		!(
			Number(batch["questionId"]) === 0
				? /^INSERT INTO pesquisa_satisfacao \(PESQ_DESCRICAO\)/
				: /^(?:UPDATE pesquisa_satisfacao SET |DELETE FROM pesquisa_satisfacao WHERE )/
		).test(statement.sql) ||
		statement.expectAffectedRows !== 1 ||
		!Array.isArray(statement.params) ||
		statement.params.length > 4 ||
		statement.params.some(
			(p: unknown) =>
				p !== null &&
				typeof p !== "string" &&
				!(typeof p === "number" && Number.isInteger(p)),
		)
	)
		return invalid();
	return {
		operation: "crm.satisfaction.question.write",
		questionId: Number(batch["questionId"]),
		tables: ["pesquisa_satisfacao", "pesquisa_satisfacao_avaliacao"],
		statements: [statement],
	};
}

function parseBatch(value: unknown): Batch {
	const invalid = (): never => {
		throw new TenantDatabaseError("TENANT_TRANSACTION_INVALID_REQUEST");
	};
	if (!value || typeof value !== "object" || Array.isArray(value))
		return invalid();
	const batch = value as Record<string, unknown>;
	if (batch["operation"] === "crm.customer.write")
		return customerBatch(batch);
	if (batch["operation"] === "crm.proposal.change")
		return proposalBatch(batch);
	if (batch["operation"] === "crm.satisfaction.question.write")
		return questionBatch(batch);
	const generation = batch["operation"] === "crm.campaign.generate";
	const finish = batch["operation"] === "telephony.schedule.finish";
	const survey = finish && batch["surveyQuestions"] !== undefined;
	if (
		survey &&
		(!Array.isArray(batch["surveyQuestions"]) ||
			!batch["surveyQuestions"].length ||
			batch["surveyQuestions"].length > 100 ||
			batch["surveyQuestions"].some((q: unknown, i: number) => {
				if (!q || typeof q !== "object" || Array.isArray(q))
					return true;
				const value = q as Record<string, unknown>;
				return (
					Object.keys(value).some(
						(k) => !["id", "description"].includes(k),
					) ||
					!Number.isInteger(value["id"]) ||
					Number(value["id"]) < 1 ||
					Number(value["id"]) > 2147483647 ||
					typeof value["description"] !== "string" ||
					value["description"].length > 1000 ||
					(i > 0 &&
						Number(
							(batch["surveyQuestions"] as { id: number }[])[
								i - 1
							]!.id,
						) >= Number(value["id"]))
				);
			}))
	)
		return invalid();
	const permitted = generation
		? new Set(generationTables)
		: finish
			? new Set([
					...finishTables,
					...proposalTables,
					...(survey ? surveyTables : []),
				])
			: allowedTables;
	const required = generation
		? generationTables
		: finish
			? [...finishTables, ...(survey ? surveyTables : [])]
			: requiredTables;
	if (
		Object.keys(batch).some(
			(key) =>
				![
					"operation",
					"tables",
					"statements",
					...(generation ? ["campaignId"] : []),
					...(finish ? ["scheduleId", "surveyQuestions"] : []),
				].includes(key),
		) ||
		(generation &&
			(!Number.isInteger(batch["campaignId"]) ||
				Number(batch["campaignId"]) < 1 ||
				Number(batch["campaignId"]) > 2147483647)) ||
		(finish &&
			(!Number.isInteger(batch["scheduleId"]) ||
				Number(batch["scheduleId"]) < 1 ||
				Number(batch["scheduleId"]) > 2147483647)) ||
		(!generation &&
			!finish &&
			batch["operation"] !== "telephony.schedule.edit") ||
		!Array.isArray(batch["tables"]) ||
		batch["tables"].length > permitted.size ||
		batch["tables"].some(
			(table) => typeof table !== "string" || !permitted.has(table),
		) ||
		required.some(
			(table) => !(batch["tables"] as unknown[]).includes(table),
		) ||
		!Array.isArray(batch["statements"]) ||
		(finish
			? batch["statements"].length < (survey ? 5 : 3) ||
				batch["statements"].length > (survey ? 47 : 45)
			: batch["statements"].length !== 2)
	)
		return invalid();
	const baseCount = finish ? (survey ? 5 : 3) : 2;
	const extensions =
		finish && batch["statements"].length > baseCount
			? finishProposalStatements(
					batch["statements"].slice(baseCount),
					Number(batch["scheduleId"]),
				)
			: [];
	if (
		["propostas", "propostas_compras", "crm_proposal_events"].some(
			(table) =>
				(batch["tables"] as string[]).includes(table) !==
				Boolean(extensions.length),
		)
	)
		return invalid();
	const statements = batch["statements"]
		.slice(0, baseCount)
		.map((input: unknown, index: number): Statement => {
			if (!input || typeof input !== "object" || Array.isArray(input))
				return invalid();
			const statement = input as Record<string, unknown>;
			const sql = statement["sql"],
				params = statement["params"];
			if (
				Object.keys(statement).some(
					(key) =>
						!["sql", "params", "expectAffectedRows"].includes(key),
				) ||
				typeof sql !== "string" ||
				Buffer.byteLength(sql) > 65_536 ||
				/;|--|\/\*|#/.test(sql) ||
				!(
					generation
						? index === 0
							? /^\s*UPDATE\s+`?campanhas`?\s/i
							: /^\s*INSERT\s+INTO\s+`?campanhas_clientes`?\s*\(/i
						: finish
							? index === 0
								? /^\s*UPDATE\s+`?campanhas_clientes`?\s/i
								: index === 1
									? /^\s*INSERT\s+INTO\s+`?historico_cli`?\s*\(/i
									: index === 2
										? /^\s*INSERT\s+INTO\s+`?telephony_schedule_finishes`?\s*\(/i
										: index === 3
											? /^INSERT INTO telephony_satisfaction_submissions \(/
											: /^INSERT INTO pesquisa_satisfacao_avaliacao \(/
							: index === 0
								? /^\s*UPDATE\s+`?campanhas_clientes`?\s/i
								: /^\s*INSERT\s+INTO\s+`?telephony_schedule_edits`?\s*\(/i
				).test(sql) ||
				((generation && index === 1) || (survey && index === 4)
					? !Number.isInteger(statement["expectAffectedRows"]) ||
						Number(statement["expectAffectedRows"]) < 0 ||
						Number(statement["expectAffectedRows"]) > 2000
					: statement["expectAffectedRows"] !== 1) ||
				!Array.isArray(params) ||
				params.length >
					(generation ? 500 : survey && index === 4 ? 300 : 200) ||
				params.some(
					(param) =>
						param !== null &&
						typeof param !== "string" &&
						typeof param !== "boolean" &&
						!(typeof param === "number" && Number.isFinite(param)),
				)
			)
				return invalid();
			if (
				/\bcampanhas_clientes_validade\b/i.test(sql) &&
				!(batch["tables"] as string[]).includes(
					"campanhas_clientes_validade",
				)
			)
				return invalid();
			if (
				survey &&
				index === 3 &&
				(sql !==
					"INSERT INTO telephony_satisfaction_submissions (operation_id,schedule_id,actor_id,history_id,survey_json,created_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP())" ||
					params.length !== 5 ||
					params[1] !== batch["scheduleId"] ||
					params[3] !== null ||
					typeof params[0] !== "string" ||
					!Number.isInteger(params[2]) ||
					Number(params[2]) < 1 ||
					typeof params[4] !== "string")
			)
				return invalid();
			if (
				survey &&
				index === 4 &&
				(statement["expectAffectedRows"] !==
					(batch["surveyQuestions"] as unknown[]).length ||
					params.length !==
						(batch["surveyQuestions"] as unknown[]).length * 3 ||
					(batch["surveyQuestions"] as { id: number }[]).some(
						(q, i) =>
							params[i * 3] !== batch["scheduleId"] ||
							params[i * 3 + 1] !== q.id ||
							!["", "1", "2", "3", "4", "5"].includes(
								String(params[i * 3 + 2]),
							),
					))
			)
				return invalid();
			return {
				sql,
				params,
				expectAffectedRows: Number(statement["expectAffectedRows"]),
			};
		});
	if(survey)validateSatisfactionEffects(statements,batch["surveyQuestions"] as {id:number;description:string}[],Number(batch["scheduleId"]));
	statements.push(...extensions);
	return {
		operation: generation
			? "crm.campaign.generate"
			: finish
				? "telephony.schedule.finish"
				: "telephony.schedule.edit",
		...(generation ? { campaignId: Number(batch["campaignId"]) } : {}),
		...(finish ? { scheduleId: Number(batch["scheduleId"]) } : {}),
		...(survey
			? {
					surveyQuestions: batch["surveyQuestions"] as {
						id: number;
						description: string;
					}[],
				}
			: {}),
		tables: [...new Set(batch["tables"] as string[])],
		statements,
	};
}

/** Signed server-to-server repository commands. Never accepts a user session as authorization. */
export function createTenantTransactionsRouter(
	database: () => Pick<TenantDatabase, "transaction"> = getTenantDatabase,
	secret: () => string | undefined = () =>
		process.env["TENANT_TRANSACTION_SECRET"],
	now: () => number = Date.now,
) {
	const router = Router();
	const nonces = new Map<string, number>();
	router.post("/api/instances/:instance/transactions", async (req, res) => {
		const reject = (
			status: number,
			code: string,
			outcome = "NOT_COMMITTED",
		) => res.status(status).json({ code, outcome });
		const key = secret();
		if (!key || Buffer.byteLength(key) < 32)
			return reject(503, "TENANT_TRANSACTION_NOT_CONFIGURED");
		const timestamp = req.get("x-tenant-timestamp") ?? "";
		const nonce = req.get("x-tenant-nonce") ?? "";
		const signature = req.get("x-tenant-signature") ?? "";
		const current = now();
		if (
			!/^\d{13}$/.test(timestamp) ||
			Math.abs(current - Number(timestamp)) > windowMs ||
			!/^[a-f0-9-]{36}$/i.test(nonce) ||
			!/^[a-f0-9]{64}$/i.test(signature) ||
			!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,190}$/.test(
				req.params["instance"] ?? "",
			)
		)
			return reject(401, "TENANT_TRANSACTION_UNAUTHORIZED");
		const body = JSON.stringify(req.body);
		if (
			!body ||
			Buffer.byteLength(body) >
				(req.body?.operation === "crm.customer.write" ||
				req.body?.surveyQuestions
					? 1_048_576
					: 131_072)
		)
			return reject(413, "TENANT_TRANSACTION_TOO_LARGE");
		const expected = createHmac("sha256", key)
			.update(`${timestamp}\n${nonce}\n${req.path}\n${body}`)
			.digest();
		if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
			return reject(401, "TENANT_TRANSACTION_UNAUTHORIZED");
		for (const [used, until] of nonces)
			if (until < current) nonces.delete(used);
		if (nonces.has(nonce))
			return reject(409, "TENANT_TRANSACTION_REPLAY", "UNKNOWN");
		if (nonces.size >= 10_000)
			return reject(429, "TENANT_TRANSACTION_BUSY");
		nonces.set(nonce, Number(timestamp) + windowMs);
		try {
			if (req.body?.operation === "crm.administration.transfer") {
				const command = parseTransfer(req.body);
				const result = await database().transaction(
					req.params["instance"]!,
					command.operation,
					transferTables,
					(tx) => transferCustomers(tx, command),
				);
				return res.json({ data: result });
			}
			const batch = parseBatch(req.body);
			const result = await database().transaction(
				req.params["instance"]!,
				batch.operation,
				batch.tables,
				async (tx) => {
					// Unknown triggers can write outside the declared tables/engines. Validate under metadata locks.
					const mutated =
						batch.operation === "crm.satisfaction.question.write"
							? ["pesquisa_satisfacao"]
							: batch.operation === "crm.customer.write"
								? [
										"clientes",
										...(batch.tables.includes(
											"motivo_desativacao_cliente",
										)
											? ["motivo_desativacao_cliente"]
											: []),
									]
								: batch.operation === "crm.campaign.generate"
									? ["campanhas", "campanhas_clientes"]
									: batch.operation ===
										  "telephony.schedule.finish"
										? [
												"campanhas_clientes",
												"historico_cli",
												"telephony_schedule_finishes",
												...(batch.surveyQuestions
													? [
															"telephony_satisfaction_submissions",
															"pesquisa_satisfacao_avaliacao",
														]
													: []),
											]
										: [
												"campanhas_clientes",
												"telephony_schedule_edits",
											];
					if (
						batch.operation === "crm.customer.write" &&
						batch.syncPhones
					)
						mutated.push("fones_campanha_cli");
					if (batch.importReceipt)
						mutated.push("crm_import_receipts");
					if (batch.operation === "crm.proposal.change")
						mutated.splice(
							0,
							mutated.length,
							"propostas",
							"crm_proposal_events",
						);
					else if (batch.tables.includes("propostas"))
						mutated.push("propostas", "crm_proposal_events");
					const triggers = await tx.execute<unknown[]>(
						`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE IN (${mutated.map(() => "?").join(", ")}) LIMIT 1`,
						mutated,
					);
					if (triggers.length)
						throw new TenantDatabaseError(
							"TENANT_TRANSACTION_UNREVIEWED_TRIGGERS",
						);
					// Serialize batches before evaluating progress subqueries. A repeated
					// request must see the previous batch's committed audience and links.
					if (batch.operation === "crm.campaign.generate") {
						const locked = await tx.execute<unknown[]>(
							"SELECT CODIGO FROM campanhas WHERE CODIGO=? FOR UPDATE",
							[batch.campaignId!],
						);
						if (locked.length !== 1)
							throw new TenantDatabaseError(
								"TENANT_TRANSACTION_AFFECTED_ROWS",
							);
					}
					if (batch.operation === "telephony.schedule.finish") {
						const locked = await tx.execute<unknown[]>(
							"SELECT CODIGO FROM campanhas_clientes WHERE CODIGO=? FOR UPDATE",
							[batch.scheduleId!],
						);
						if (locked.length !== 1)
							throw new TenantDatabaseError(
								"TENANT_TRANSACTION_AFFECTED_ROWS",
							);
					}
					if (
						batch.operation === "crm.satisfaction.question.write" ||
						batch.surveyQuestions
					) {
						// Lock the full catalog range, including gaps: empty catalogs and new questions serialize too.
						const questions = await tx.execute<
							{ PESQSAT_CODIGO: number; PESQ_DESCRICAO: string }[]
						>(
							"SELECT PESQSAT_CODIGO,PESQ_DESCRICAO FROM pesquisa_satisfacao ORDER BY PESQSAT_CODIGO LIMIT 101 FOR UPDATE",
						);
						if (
							questions.length > 100 ||
							(batch.surveyQuestions &&
								JSON.stringify(
									questions.map((q) => ({
										id: Number(q.PESQSAT_CODIGO),
										description: q.PESQ_DESCRICAO,
									})),
								) !== JSON.stringify(batch.surveyQuestions))
						)
							throw new TenantDatabaseError(
								"TENANT_TRANSACTION_AFFECTED_ROWS",
							);
						if (
							batch.operation ===
								"crm.satisfaction.question.write" &&
							batch.questionId === 0 &&
							questions.length >= 100
						)
							throw new TenantDatabaseError(
								"TENANT_TRANSACTION_AFFECTED_ROWS",
							);
						if (batch.surveyQuestions) {
							const existing = await tx.execute<unknown[]>(
								"SELECT PESQSAT_CODIGO FROM pesquisa_satisfacao_avaliacao WHERE CAMPCLI_CODIGO=? LIMIT 1 FOR UPDATE",
								[batch.scheduleId!],
							);
							if (existing.length)
								throw new TenantDatabaseError(
									"TENANT_TRANSACTION_AFFECTED_ROWS",
								);
						}
						if (
							batch.operation ===
								"crm.satisfaction.question.write" &&
							batch.questionId
						) {
							const used = await tx.execute<unknown[]>(
								"SELECT CAMPCLI_CODIGO FROM pesquisa_satisfacao_avaliacao WHERE PESQSAT_CODIGO=? LIMIT 1 FOR UPDATE",
								[batch.questionId],
							);
							if (used.length)
								throw new TenantDatabaseError(
									"TENANT_TRANSACTION_AFFECTED_ROWS",
								);
						}
					}
					// Lock proposals and purchase links in a stable order before CAS. InnoDB
					// next-key locks prevent a concurrent purchase link from bypassing the guard.
					if (batch.tables.includes("propostas")) {
						if (batch.statements.some((s) => s.sql === deleteSql)) {
							const refs = await tx.execute<
								{
									local_schema: number;
									TABLE_NAME: string;
									COLUMN_NAME: string;
									REFERENCED_COLUMN_NAME: string;
								}[]
							>(
								"SELECT TABLE_SCHEMA=DATABASE() AS local_schema,TABLE_NAME,COLUMN_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='propostas'",
								[],
							);
							if (
								refs.some(
									(r) =>
										Number(r.local_schema) !== 1 ||
										r.TABLE_NAME !== "propostas_compras" ||
										r.COLUMN_NAME !== "PROPOSTA" ||
										r.REFERENCED_COLUMN_NAME !== "CODIGO",
								)
							)
								throw new TenantDatabaseError(
									"TENANT_PROPOSAL_UNREVIEWED_REFERENCES",
								);
						}
						if (batch.operation === "crm.proposal.change") {
							const operationId = batch.statements[1]!.params[0];
							const used = await tx.execute<unknown[]>(
								"SELECT operation_id FROM crm_proposal_events WHERE operation_id=? FOR UPDATE",
								[operationId],
							);
							if (used.length)
								throw new TenantDatabaseError(
									"TENANT_TRANSACTION_AFFECTED_ROWS",
								);
						}
						const ids = batch.statements
							.filter((s) => s.sql === eventSql)
							.map((s) => Number(s.params[2]))
							.sort((a, b) => a - b);
						for (const id of ids) {
							if (
								!Number.isInteger(id) ||
								id < 1 ||
								id > 2147483647
							)
								throw new TenantDatabaseError(
									"TENANT_TRANSACTION_INVALID_REQUEST",
								);
							await tx.execute(
								"SELECT CODIGO FROM propostas WHERE CODIGO=? FOR UPDATE",
								[id],
							);
							await tx.execute(
								"SELECT PROPOSTA FROM propostas_compras WHERE PROPOSTA=? FOR UPDATE",
								[id],
							);
						}
					}
					const results: unknown[] = [];
					if (batch.operation === "crm.customer.write") {
						// All web customer writers serialize before policy/duplicate predicates.
						const policy = await tx.execute<unknown[]>(
							"SELECT CODIGO FROM parametros ORDER BY CODIGO LIMIT 2 FOR UPDATE",
						);
						if (policy.length !== 1)
							throw new TenantDatabaseError(
								"TENANT_CUSTOMER_POLICY_UNAVAILABLE",
							);
						if (batch.importReceipt) {
							const existingId = await findImportReceipt(
								tx,
								batch.importReceipt,
							);
							if (existingId !== null)
								return [
									{ affectedRows: 1, insertId: existingId },
								];
						}
						if (batch.customerId) {
							const rows = await tx.execute<unknown[]>(
								"SELECT CODIGO FROM clientes WHERE CODIGO=? FOR UPDATE",
								[batch.customerId],
							);
							if (rows.length !== 1)
								throw new TenantDatabaseError(
									"TENANT_TRANSACTION_AFFECTED_ROWS",
								);
						}
					}
					let historyId: number | undefined;
					for (const [
						statementIndex,
						statement,
					] of batch.statements.entries()) {
						const parameters = [...statement.params];
						if (batch.surveyQuestions && statementIndex === 3) {
							if (!historyId)
								throw new TenantDatabaseError(
									"TENANT_TRANSACTION_AFFECTED_ROWS",
								);
							parameters[3] = historyId;
						}
						const result = await tx.execute<{
							affectedRows?: number;
							insertId?: number;
						}>(statement.sql, parameters);
						if (
							result?.affectedRows !==
							statement.expectAffectedRows
						)
							throw new TenantDatabaseError(
								"TENANT_TRANSACTION_AFFECTED_ROWS",
							);
						if (batch.surveyQuestions && statementIndex === 1) {
							if (
								!Number.isSafeInteger(result.insertId) ||
								Number(result.insertId) < 1 ||
								Number(result.insertId) > 2147483647
							)
								throw new TenantDatabaseError(
									"TENANT_TRANSACTION_AFFECTED_ROWS",
								);
							historyId = result.insertId;
						}
						// Transport only acknowledgements, never driver metadata or SQL.
						results.push({
							affectedRows: result.affectedRows,
							...(batch.operation === "crm.customer.write" &&
							Number.isSafeInteger(result.insertId) &&
							Number(result.insertId) > 0
								? { insertId: result.insertId }
								: {}),
						});
					}
					if (
						batch.operation === "crm.customer.write" &&
						batch.syncPhones
					) {
						const customerId =
							batch.customerId ||
							(results[0] as { insertId?: number }).insertId;
						await synchronizeCustomerPhones(tx, Number(customerId));
					}
					if (batch.importReceipt) {
						const customerId = Number(
							(results[0] as { insertId?: number } | undefined)
								?.insertId,
						);
						await writeImportReceipt(
							tx,
							batch.importReceipt,
							customerId,
						);
					}
					return results;
				},
			);
			return res.json({ data: result });
		} catch (error) {
			const safe =
				error instanceof TenantDatabaseError
					? error
					: new TenantDatabaseError(
							"TENANT_TRANSACTION_FAILED",
							"UNKNOWN",
						);
			return reject(
				safe.code === "TENANT_TRANSACTION_INVALID_REQUEST"
					? 400
					: safe.code === "TENANT_IMPORT_FORBIDDEN"
						? 403
						: [
									"TENANT_TRANSACTION_AFFECTED_ROWS",
									"TENANT_IMPORT_DUPLICATE",
									"TENANT_IMPORT_OPERATION_REUSED",
							  ].includes(safe.code)
							? 409
							: 503,
				safe.code,
				safe.outcome,
			);
		}
	});
	return router;
}
