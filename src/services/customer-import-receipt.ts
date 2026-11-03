import { TenantDatabaseError } from "../tenant-database/error";
import type { TenantTransaction } from "../tenant-database/transaction";

export interface CustomerImportReceipt {
	key: string;
	actorId: number;
	identity: "document" | "phone";
	requestHash: string;
}
const fail = (code = "TENANT_TRANSACTION_INVALID_REQUEST"): never => {
	throw new TenantDatabaseError(code);
};
export function parseImportReceipt(value: unknown): CustomerImportReceipt {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return fail();
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).some(
			(key) =>
				!["key", "actorId", "identity", "requestHash"].includes(key),
		) ||
		typeof input["key"] !== "string" ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}:[1-9]\d{0,2}$/.test(
			input["key"],
		) ||
		Number(input["key"].split(":")[1]) < 2 ||
		Number(input["key"].split(":")[1]) > 501 ||
		!Number.isInteger(input["actorId"]) ||
		Number(input["actorId"]) < 1 ||
		Number(input["actorId"]) > 2147483647 ||
		!["document", "phone"].includes(String(input["identity"])) ||
		typeof input["requestHash"] !== "string" ||
		!/^[a-f0-9]{64}$/.test(input["requestHash"])
	)
		return fail();
	return {
		key: input["key"],
		actorId: Number(input["actorId"]),
		identity: input["identity"] as CustomerImportReceipt["identity"],
		requestHash: input["requestHash"],
	};
}
/** Called after the shared customer-policy lock. No caller SQL or optional retry. */
export async function findImportReceipt(
	tx: TenantTransaction,
	receipt: CustomerImportReceipt,
): Promise<number | null> {
	const columns = await tx.execute<
		{
			COLUMN_NAME: string;
			DATA_TYPE: string;
			CHARACTER_MAXIMUM_LENGTH: number | null;
			IS_NULLABLE: string;
		}[]
	>(
		"SELECT COLUMN_NAME,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='crm_import_receipts' ORDER BY ORDINAL_POSITION LIMIT 21",
	);
	const expected: Record<string, string[]> = {
		operation_key: ["char", "varchar"],
		request_hash: ["char", "varchar"],
		actor_id: ["int"],
		customer_id: ["int"],
		created_at: ["datetime", "timestamp"],
	};
	if (
		columns.length > 20 ||
		Object.entries(expected).some(
			([key, types]) =>
				!columns.some(
					(column) =>
						column.COLUMN_NAME === key &&
						types.includes(column.DATA_TYPE) &&
						column.IS_NULLABLE === "NO" &&
						(key === "operation_key"
							? Number(column.CHARACTER_MAXIMUM_LENGTH) >= 80
							: key === "request_hash"
								? Number(column.CHARACTER_MAXIMUM_LENGTH) >= 64
								: true),
				),
		)
	)
		return fail("TENANT_IMPORT_RECEIPT_SCHEMA_UNSUPPORTED");
	const primary = await tx.execute<
		{ COLUMN_NAME: string; SUB_PART: number | null }[]
	>(
		"SELECT COLUMN_NAME,SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='crm_import_receipts' AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX LIMIT 3",
	);
	if (
		primary.length !== 1 ||
		primary[0]!.COLUMN_NAME !== "operation_key" ||
		primary[0]!.SUB_PART !== null
	)
		return fail("TENANT_IMPORT_RECEIPT_SCHEMA_UNSUPPORTED");
	const actors = await tx.execute<
		{ CODIGO: number; ATIVO: string; NIVEL: string }[]
	>("SELECT CODIGO,ATIVO,NIVEL FROM operadores WHERE CODIGO=? FOR UPDATE", [
		receipt.actorId,
	]);
	if (
		actors.length !== 1 ||
		Number(actors[0]!.CODIGO) !== receipt.actorId ||
		actors[0]!.ATIVO !== "SIM" ||
		actors[0]!.NIVEL !== "ADMIN"
	)
		return fail("TENANT_IMPORT_FORBIDDEN");
	const rows = await tx.execute<
		{ request_hash: string; actor_id: number; customer_id: number }[]
	>(
		"SELECT request_hash,actor_id,customer_id FROM crm_import_receipts WHERE operation_key=? FOR UPDATE",
		[receipt.key],
	);
	if (rows.length > 1)
		return fail("TENANT_IMPORT_RECEIPT_SCHEMA_UNSUPPORTED");
	if (!rows.length) return null;
	const row = rows[0]!;
	if (
		row.request_hash !== receipt.requestHash ||
		Number(row.actor_id) !== receipt.actorId
	)
		return fail("TENANT_IMPORT_OPERATION_REUSED");
	if (
		!Number.isSafeInteger(Number(row.customer_id)) ||
		Number(row.customer_id) < 1 ||
		Number(row.customer_id) > 2147483647
	)
		return fail("TENANT_IMPORT_RECEIPT_SCHEMA_UNSUPPORTED");
	return Number(row.customer_id);
}
const slots = [
	["AREA1", "FONE1"],
	["AREA2", "FONE2"],
	["AREA3", "FONE3"],
	["AREAFAX", "FAX"],
] as const;
function normalizedSql(column: string): string {
	// Same punctuation accepted in historical document/phone identification; no regex SQL/version dependency.
	return [".", "/", "-", " ", "(", ")", "+"].reduce(
		(sql, token) => `REPLACE(${sql},'${token}','')`,
		`COALESCE(CAST(\`${column}\` AS CHAR),'')`,
	);
}
/** Rechecks actual inserted identity under the policy lock, even for permissive tenant policies. */
export async function writeImportReceipt(
	tx: TenantTransaction,
	receipt: CustomerImportReceipt,
	customerId: number,
): Promise<void> {
	if (
		!Number.isSafeInteger(customerId) ||
		customerId < 1 ||
		customerId > 2147483647
	)
		return fail();
	const columns = await tx.execute<{ COLUMN_NAME: string }[]>(
		"SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='clientes' AND COLUMN_NAME IN ('CPF_CNPJ','AREA1','FONE1','AREA2','FONE2','AREA3','FONE3','AREAFAX','FAX') ORDER BY ORDINAL_POSITION LIMIT 10",
	);
	const names = new Set(columns.map((column) => column.COLUMN_NAME));
	const pairs = slots.filter(
		([area, number]) => names.has(area) && names.has(number),
	);
	if (
		!pairs.length ||
		(receipt.identity === "document" && !names.has("CPF_CNPJ"))
	)
		return fail("TENANT_IMPORT_RECEIPT_SCHEMA_UNSUPPORTED");
	const fields = [
		...(names.has("CPF_CNPJ") ? ["CPF_CNPJ"] : []),
		...pairs.flat(),
	];
	const rows = await tx.execute<Record<string, unknown>[]>(
		`SELECT ${fields.map((field) => `\`${field}\``).join(",")} FROM clientes WHERE CODIGO=? FOR UPDATE`,
		[customerId],
	);
	if (rows.length !== 1) return fail("TENANT_TRANSACTION_AFFECTED_ROWS");
	const document = String(rows[0]!["CPF_CNPJ"] ?? "").replace(
		/[.\/\- ()+]/g,
		"",
	);
	if (
		(document && !/^\d{11}(?:\d{3})?$/.test(document)) ||
		(receipt.identity === "document" && !document)
	)
		return fail("TENANT_IMPORT_IDENTITY_INVALID");
	const clauses: string[] = [],
		params: unknown[] = [customerId];
	if (document) {
		clauses.push(`${normalizedSql("CPF_CNPJ")}=?`);
		params.push(document);
	}
	if (receipt.identity === "phone") {
		const phones = [
			...new Set(
				pairs
					.map(
						([area, number]) =>
							String(rows[0]![area] ?? "") +
							String(rows[0]![number] ?? ""),
					)
					.filter((phone) => /^[1-9]\d\d{8,9}$/.test(phone)),
			),
		];
		if (!phones.length) return fail("TENANT_IMPORT_IDENTITY_INVALID");
		for (const [area, number] of pairs) {
			clauses.push(
				`CONCAT(${normalizedSql(area)},${normalizedSql(number)}) IN (${phones.map(() => "?").join(",")})`,
			);
			params.push(...phones);
		}
	}
	const duplicates = await tx.execute<unknown[]>(
		`SELECT CODIGO FROM clientes WHERE CODIGO<>? AND (${clauses.join(" OR ")}) LIMIT 1 FOR UPDATE`,
		params,
	);
	if (duplicates.length) return fail("TENANT_IMPORT_DUPLICATE");
	const inserted = await tx.execute<{ affectedRows: number }>(
		"INSERT INTO crm_import_receipts (operation_key,request_hash,actor_id,customer_id,created_at) VALUES (?,?,?,?,UTC_TIMESTAMP())",
		[receipt.key, receipt.requestHash, receipt.actorId, customerId],
	);
	if (inserted.affectedRows !== 1)
		return fail("TENANT_TRANSACTION_AFFECTED_ROWS");
}
