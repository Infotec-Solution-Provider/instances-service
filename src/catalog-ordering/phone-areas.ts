import type { TenantDatabase } from "../tenant-database/tenant-database";
import { TenantDatabaseError } from "../tenant-database/error";

const fail = (code = "TENANT_ORDERING_INVALID"): never => {
	throw new TenantDatabaseError(code);
};
function object(value: unknown, allowed: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !allowed.includes(key))
	)
		return fail();
	return value as Record<string, unknown>;
}
function description(value: unknown, original = false): string | null {
	if (original && value === null) return null;
	if (
		typeof value !== "string" ||
		value.length > 20 ||
		(!original && (!value.trim() || value !== value.trim())) ||
		[...value].some(
			(char) =>
				char.charCodeAt(0) > 255 ||
				(!original &&
					(char.charCodeAt(0) < 32 ||
						(char.charCodeAt(0) >= 127 &&
							char.charCodeAt(0) < 160))),
		)
	)
		return fail();
	return value;
}
/** Typed repository commands only. Never accept caller SQL or mutate a DDD primary key. */
export async function writePhoneArea(
	database: Pick<TenantDatabase, "transaction">,
	tenant: string,
	input: unknown,
) {
	const body = object(input, ["action", "fields", "expected"]);
	const create = body["action"] === "phone-area-create";
	if (!create && body["action"] !== "phone-area-patch") return fail();
	if (create && Object.hasOwn(body, "expected")) return fail();
	const fields = object(body["fields"], ["CODIGO", "DESCRICAO"]),
		code = fields["CODIGO"];
	if (
		typeof code !== "string" ||
		!(create ? /^[1-9]\d$/ : /^\d{1,5}$/).test(code)
	)
		return fail();
	const label = description(fields["DESCRICAO"]);
	const expected = create
		? null
		: description(
				object(body["expected"], ["DESCRICAO"])["DESCRICAO"],
				true,
			);
	return database.transaction(
		tenant,
		`crm.phone-area.${create ? "create" : "patch"}`,
		["fone_areas"],
		async (tx) => {
			// Actual tenant capabilities, not Prisma inference. The shared transaction also requires InnoDB.
			const columns = await tx.execute<
				{
					COLUMN_NAME: string;
					DATA_TYPE: string;
					CHARACTER_MAXIMUM_LENGTH: number | null;
					COLUMN_KEY: string;
				}[]
			>(
				"SELECT COLUMN_NAME,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fone_areas'",
				[],
			);
			const key = columns.find((row) => row.COLUMN_NAME === "CODIGO"),
				text = columns.find((row) => row.COLUMN_NAME === "DESCRICAO");
			if (
				!key ||
				!["char", "varchar"].includes(key.DATA_TYPE) ||
				Number(key.CHARACTER_MAXIMUM_LENGTH) < code.length ||
				key.COLUMN_KEY !== "PRI" ||
				columns.filter((row) => row.COLUMN_KEY === "PRI").length !==
					1 ||
				!text ||
				!["char", "varchar"].includes(text.DATA_TYPE) ||
				Number(text.CHARACTER_MAXIMUM_LENGTH) < 20
			)
				return fail("TENANT_ORDERING_SCHEMA_UNAVAILABLE");
			const triggers = await tx.execute<unknown[]>(
				"SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='fone_areas' LIMIT 1",
				[],
			);
			if (triggers.length)
				return fail("TENANT_TRANSACTION_UNREVIEWED_TRIGGERS");
			const existing = await tx.execute<
				{ CODIGO: string; DESCRICAO: string | null }[]
			>(
				"SELECT CODIGO,DESCRICAO FROM fone_areas WHERE CODIGO=? FOR UPDATE",
				[code],
			);
			if (create) {
				if (existing.length) return fail("TENANT_DUPLICATE_KEY");
				const result = await tx.execute<{ affectedRows: number }>(
					"INSERT INTO fone_areas (CODIGO,DESCRICAO) VALUES (?,?)",
					[code, label],
				);
				if (result.affectedRows !== 1)
					return fail("TENANT_ORDERING_CHANGED");
			} else {
				if (
					existing.length !== 1 ||
					existing[0]!.CODIGO !== code ||
					existing[0]!.DESCRICAO !== expected
				)
					return fail("TENANT_ORDERING_CHANGED");
				// A no-op is successful only after checking the entire expected snapshot under lock.
				if (label !== expected) {
					const result = await tx.execute<{ affectedRows: number }>(
						"UPDATE fone_areas SET DESCRICAO=? WHERE CODIGO=? AND CAST(CONVERT(DESCRICAO USING utf8mb4) AS BINARY) <=> CAST(CONVERT(? USING utf8mb4) AS BINARY)",
						[label, code, expected],
					);
					if (result.affectedRows !== 1)
						return fail("TENANT_ORDERING_CHANGED");
				}
			}
			return { CODIGO: code, DESCRICAO: label };
		},
	);
}
