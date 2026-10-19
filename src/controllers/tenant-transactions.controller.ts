import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { getTenantDatabase } from "../services/tenant-database.service";
import { TenantDatabaseError } from "../tenant-database/error";
import type { TenantDatabase } from "../tenant-database/tenant-database";

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
const generationTables = ["campanhas", "campanhas_clientes", "clientes", "operadores", "excecoes", "excecoes_cidade", "excecoes_estado", "excecoes_segmentos"];
const windowMs = 60_000;
interface Statement {
	sql: string;
	params: (string | number | boolean | null)[];
	expectAffectedRows: number;
}
interface Batch {
	operation: string;
	campaignId?: number;
	tables: string[];
	statements: Statement[];
}

function parseBatch(value: unknown): Batch {
	const invalid = (): never => {
		throw new TenantDatabaseError("TENANT_TRANSACTION_INVALID_REQUEST");
	};
	if (!value || typeof value !== "object" || Array.isArray(value))
		return invalid();
	const batch = value as Record<string, unknown>;
	const generation = batch["operation"] === "crm.campaign.generate";
	const permitted = generation ? new Set(generationTables) : allowedTables;
	const required = generation ? generationTables : requiredTables;
	if (
		Object.keys(batch).some(
			(key) => !["operation", "tables", "statements", ...(generation ? ["campaignId"] : [])].includes(key),
		) ||
		(generation && (!Number.isInteger(batch["campaignId"]) || Number(batch["campaignId"]) < 1 || Number(batch["campaignId"]) > 2147483647)) ||
		(!generation && batch["operation"] !== "telephony.schedule.edit") ||
		!Array.isArray(batch["tables"]) ||
		batch["tables"].length > permitted.size ||
		batch["tables"].some(
			(table) => typeof table !== "string" || !permitted.has(table),
		) ||
		required.some(
			(table) => !(batch["tables"] as unknown[]).includes(table),
		) ||
		!Array.isArray(batch["statements"]) ||
		batch["statements"].length !== 2
	)
		return invalid();
	const statements = batch["statements"].map(
		(input: unknown, index: number): Statement => {
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
						? index === 0 ? /^\s*UPDATE\s+`?campanhas`?\s/i : /^\s*INSERT\s+INTO\s+`?campanhas_clientes`?\s*\(/i
						: index === 0 ? /^\s*UPDATE\s+`?campanhas_clientes`?\s/i : /^\s*INSERT\s+INTO\s+`?telephony_schedule_edits`?\s*\(/i
				).test(sql) ||
				(generation && index === 1
					? !Number.isInteger(statement["expectAffectedRows"]) || Number(statement["expectAffectedRows"]) < 0 || Number(statement["expectAffectedRows"]) > 2000
					: statement["expectAffectedRows"] !== 1) ||
				!Array.isArray(params) ||
				params.length > (generation ? 500 : 200) ||
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
			return { sql, params, expectAffectedRows: Number(statement["expectAffectedRows"]) };
		},
	);
	return {
		operation: generation ? "crm.campaign.generate" : "telephony.schedule.edit",
		...(generation ? { campaignId: Number(batch["campaignId"]) } : {}),
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
		if (!body || Buffer.byteLength(body) > 131_072)
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
			const batch = parseBatch(req.body);
			const result = await database().transaction(
				req.params["instance"]!,
				batch.operation,
				batch.tables,
				async (tx) => {
					// Unknown triggers can write outside the declared tables/engines. Validate under metadata locks.
					const triggers = await tx.execute<unknown[]>(
						"SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE IN (?, ?) LIMIT 1",
						batch.operation === "crm.campaign.generate" ? ["campanhas", "campanhas_clientes"] : ["campanhas_clientes", "telephony_schedule_edits"],
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
							throw new TenantDatabaseError("TENANT_TRANSACTION_AFFECTED_ROWS");
					}
					const results: unknown[] = [];
					for (const statement of batch.statements) {
						const result = await tx.execute<{
							affectedRows?: number;
						}>(statement.sql, statement.params);
						if (
							result?.affectedRows !==
							statement.expectAffectedRows
						)
							throw new TenantDatabaseError(
								"TENANT_TRANSACTION_AFFECTED_ROWS",
							);
						// Transport only acknowledgements, never driver metadata or SQL.
						results.push({ affectedRows: result.affectedRows });
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
					: safe.code === "TENANT_TRANSACTION_AFFECTED_ROWS"
						? 409
						: 503,
				safe.code,
				safe.outcome,
			);
		}
	});
	return router;
}
