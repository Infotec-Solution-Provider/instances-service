import type { TenantDatabase } from "../tenant-database/tenant-database";
import type { TenantTransaction } from "../tenant-database/transaction";
import { TenantDatabaseError } from "../tenant-database/error";

type Row = Record<string, string | number | null>;
export const campaignTypes = ["ATIVOS", "INAT_R", "INAT_A", "PROSPE"] as const;
const unitFields = [
	"CODIGO",
	"DESCRICAO",
	"INATIVOS_RECENTES",
	"INATIVOS_ANTIGOS",
];
const campaignFields = [
	"CODIGO",
	"NOME",
	"DATA_INI",
	"MAX_RESPOSTA",
	"DESCRICAO",
	"PRIORIDADE",
	"SQL_CAMPANHA",
	"GERADO_LISTA",
	"PAUSADA",
	"PAUSAR_AG_PUBLICA",
	"TIPO",
	"UNIDADE",
	"OPERADOR",
];
const fail = (code = "TENANT_ORDERING_INVALID"): never => {
	throw new TenantDatabaseError(code);
};
function object(
	input: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		Object.keys(input).some((k) => !keys.includes(k))
	)
		return fail();
	return input as Record<string, unknown>;
}
function number(value: unknown, min = 1): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < min ||
		value > 2147483647
	)
		return fail();
	return value;
}
function text(value: unknown, max: number): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > max ||
		/[^\u0020-\u007e\u00a0-\u00ff\r\n\t]/.test(value)
	)
		return fail();
	return value.trim();
}
function thresholds(row: Row) {
	const recent = number(row["INATIVOS_RECENTES"]),
		old = number(row["INATIVOS_ANTIGOS"]);
	if (recent >= old) return fail();
}
function complete(rows: Row[]) {
	return (
		rows.length === 4 &&
		campaignTypes.every(
			(t) => rows.filter((r) => r["TIPO"] === t).length === 1,
		)
	);
}
function same(a: Row, b: Row, keys = Object.keys(a)) {
	return keys.every((k) => a[k] === b[k]);
}
async function insert(
	tx: TenantTransaction,
	table: "unidades" | "campanhas",
	fields: Row,
) {
	const keys = Object.keys(fields);
	const result = await tx.execute<{ affectedRows: number }>(
		`INSERT INTO \`${table}\` (${keys.map((k) => `\`${k}\``).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
		Object.values(fields),
	);
	if (result.affectedRows !== 1)
		return fail("TENANT_TRANSACTION_AFFECTED_ROWS");
}

/** Repository-owned commands, carried by the existing signed catalog endpoint. No caller SQL. */
export class CrmUnitsService {
	constructor(
		private readonly database: Pick<TenantDatabase, "transaction">,
	) {}
	async execute(tenant: string, input: unknown) {
		const body = object(input, [
			"action",
			"command",
			"id",
			"fields",
			"campaigns",
			"changes",
			"expected",
		]);
		if (body["action"] !== "units") return fail();
		const command = body["command"];
		const permitted: Record<string, string[]> = {
			list: ["action", "command"],
			detail: ["action", "command", "id"],
			create: ["action", "command", "fields", "campaigns"],
			patch: ["action", "command", "id", "changes", "expected"],
			"campaign-create": ["action", "command", "fields"],
			"campaign-patch": [
				"action",
				"command",
				"id",
				"changes",
				"expected",
			],
		};
		if (typeof command !== "string" || !Object.hasOwn(permitted, command))
			return fail();
		object(body, permitted[command]!);
		const writing = !["list", "detail"].includes(command);
		return this.database.transaction(
			tenant,
			"crm.catalog-ordering.units",
			["parametros", "unidades", "campanhas"],
			async (tx) => {
				// Same first lock as ordering/customer commands. Range locks prevent duplicate unit/type inserts.
				const policy = await tx.execute<Row[]>(
					"SELECT CODIGO FROM parametros ORDER BY CODIGO LIMIT 2 FOR UPDATE",
				);
				if (policy.length !== 1)
					return fail("TENANT_ORDERING_POLICY_UNAVAILABLE");
				const columns = await tx.execute<
					{
						tableName: string;
						name: string;
						type: string;
						maxLength: number | null;
						nullable: string;
						defaultValue: unknown;
						extra: string;
					}[]
				>(
					"SELECT TABLE_NAME AS tableName,COLUMN_NAME AS name,COLUMN_TYPE AS type,CHARACTER_MAXIMUM_LENGTH AS maxLength,IS_NULLABLE AS nullable,COLUMN_DEFAULT AS defaultValue,EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('unidades','campanhas') ORDER BY ORDINAL_POSITION",
				);
				for (const [table, required] of [
					["unidades", unitFields],
					[
						"campanhas",
						[
							"CODIGO",
							"NOME",
							"TIPO",
							"UNIDADE",
							"PAUSADA",
							"PRIORIDADE",
						],
					],
				] as const) {
					if (
						required.some(
							(k) =>
								!columns.some(
									(c) =>
										c.tableName === table && c.name === k,
								),
						)
					)
						return fail("TENANT_ORDERING_SCHEMA_UNAVAILABLE");
				}
				// A missing/changed tenant column never causes fallback to a different schema.
				const unitColumns = columns.filter(
					(c) =>
						c.tableName === "unidades" &&
						unitFields.includes(c.name),
				);
				const campaignColumns = columns.filter(
					(c) =>
						c.tableName === "campanhas" &&
						campaignFields.includes(c.name),
				);
				const validate = (table: string, fields: Row) => {
					for (const [key, value] of Object.entries(fields)) {
						const spec = columns.find(
							(c) => c.tableName === table && c.name === key,
						);
						if (!spec)
							return fail("TENANT_ORDERING_SCHEMA_UNAVAILABLE");
						if (value === null) {
							if (spec.nullable !== "YES") return fail();
							continue;
						}
						if (/^(tinyint|smallint|int)/.test(spec.type)) {
							const bits = spec.type.startsWith("tinyint")
								? 8
								: spec.type.startsWith("smallint")
									? 16
									: 32;
							const unsigned = spec.type.includes("unsigned");
							if (
								typeof value !== "number" ||
								!Number.isInteger(value) ||
								value < (unsigned ? 0 : -(2 ** (bits - 1))) ||
								value >
									(unsigned
										? 2 ** bits - 1
										: 2 ** (bits - 1) - 1)
							)
								return fail();
						} else if (spec.type.startsWith("enum(")) {
							if (
								typeof value !== "string" ||
								![...spec.type.matchAll(/'([^']*)'/g)].some(
									(m) => m[1] === value,
								)
							)
								return fail();
						} else if (spec.type === "datetime") {
							if (
								typeof value !== "string" ||
								!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
							)
								return fail();
							const parsed = new Date(
								value.replace(" ", "T") + "Z",
							);
							if (
								!Number.isFinite(parsed.getTime()) ||
								parsed.toISOString().slice(0, 19) !==
									value.replace(" ", "T") ||
								Number(value.slice(0, 4)) < 1000
							)
								return fail();
						} else if (/^(varchar|char|text)/.test(spec.type)) {
							if (
								typeof value !== "string" ||
								value.length >
									Number(spec.maxLength ?? 65535) ||
								/[^\u0020-\u007e\u00a0-\u00ff\r\n\t]/.test(
									value,
								)
							)
								return fail();
						} else
							return fail("TENANT_ORDERING_SCHEMA_UNAVAILABLE");
					}
				};
				const units = await tx.execute<Row[]>(
					`SELECT ${unitColumns.map((c) => `\`${c.name}\``).join(",")} FROM unidades ORDER BY CODIGO LIMIT 20001 FOR UPDATE`,
				);
				const campaigns = await tx.execute<Row[]>(
					`SELECT ${campaignColumns.map((c) => (c.type === "datetime" ? `CAST(\`${c.name}\` AS CHAR) AS \`${c.name}\`` : `\`${c.name}\``)).join(",")} FROM campanhas ORDER BY CODIGO LIMIT 20001 FOR UPDATE`,
				);
				if (units.length > 20000 || campaigns.length > 20000)
					return fail("TENANT_ORDERING_TOO_LARGE");
				const view = (unit: Row) => ({
					...unit,
					campaignCount: campaigns.filter(
						(c) => c["UNIDADE"] === unit["CODIGO"],
					).length,
					activationAvailable: complete(
						campaigns.filter(
							(c) => c["UNIDADE"] === unit["CODIGO"],
						),
					),
				});
				if (command === "list")
					return {
						data: units.map(view),
						supportedTypes: campaignTypes,
					};
				if (writing) {
					const keys = await tx.execute<
						{ tableName: string; name: string }[]
					>(
						"SELECT TABLE_NAME AS tableName,COLUMN_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('unidades','campanhas') AND INDEX_NAME='PRIMARY' ORDER BY TABLE_NAME,SEQ_IN_INDEX",
					);
					if (
						["unidades", "campanhas"].some(
							(t) =>
								keys.filter((k) => k.tableName === t).length !==
									1 ||
								!keys.some(
									(k) =>
										k.tableName === t &&
										k.name === "CODIGO",
								),
						)
					)
						return fail("TENANT_ORDERING_SCHEMA_UNAVAILABLE");
					const triggers = await tx.execute<unknown[]>(
						"SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN ('unidades','campanhas') LIMIT 1",
					);
					if (triggers.length)
						return fail("TENANT_TRANSACTION_UNREVIEWED_TRIGGERS");
				}
				const unitId =
					body["id"] === undefined
						? undefined
						: number(body["id"], -2147483648);
				const unit = units.find((u) => u["CODIGO"] === unitId);
				if (command === "detail") {
					if (!unit) return fail("TENANT_ORDERING_UNIT_UNAVAILABLE");
					return {
						data: unit,
						campaigns: campaigns.filter(
							(c) => c["UNIDADE"] === unitId,
						),
						supportedTypes: campaignTypes,
					};
				}
				if (command === "patch") {
					if (!unit) return fail("TENANT_ORDERING_UNIT_UNAVAILABLE");
					const changes = object(body["changes"], [
						"DESCRICAO",
					]) as Row;
					const expected = object(
						body["expected"],
						unitFields,
					) as Row;
					if (
						Object.keys(expected).length !== unitColumns.length ||
						!same(unit, expected)
					)
						return fail("TENANT_ORDERING_CHANGED");
					const next = text(changes["DESCRICAO"], 50);
					validate("unidades", { DESCRICAO: next });
					const duplicates = await tx.execute<Row[]>(
						"SELECT CODIGO FROM unidades WHERE DESCRICAO=? AND CODIGO<>? LIMIT 1 FOR UPDATE",
						[next, unitId],
					);
					if (duplicates.length) return fail("TENANT_DUPLICATE_KEY");
					await tx.execute(
						"UPDATE unidades SET DESCRICAO=? WHERE CODIGO=?",
						[next, unitId],
					);
					return { ...unit, DESCRICAO: next };
				}
				const prepare = (raw: unknown, id: number): Row => {
					const fields = object(
						raw,
						campaignFields.filter(
							(k) =>
								![
									"SQL_CAMPANHA",
									"GERADO_LISTA",
									"PRIORIDADE",
									"UNIDADE",
								].includes(k),
						),
					) as Row;
					number(fields["CODIGO"]);
					text(fields["NOME"], 150);
					if (
						!campaignTypes.includes(
							fields["TIPO"] as (typeof campaignTypes)[number],
						)
					)
						return fail();
					if (
						fields["PAUSADA"] !== undefined &&
						fields["PAUSADA"] !== "SIM"
					)
						return fail("TENANT_ORDERING_COMPOSITION_PENDING");
					const result: Row = {
						...fields,
						UNIDADE: id,
						PAUSADA: "SIM",
					};
					for (const column of campaignColumns) {
						if (
							column.type === "datetime" &&
							column.nullable === "YES" &&
							String(column.defaultValue).startsWith("0000-") &&
							!Object.hasOwn(result, column.name)
						)
							result[column.name] = null;
					}
					const max = campaigns.reduce(
						(n, c) => Math.max(n, Number(c["PRIORIDADE"]) || 0),
						0,
					);
					result["PRIORIDADE"] = number(max + 1);
					validate("campanhas", result);
					if (campaigns.some((c) => c["CODIGO"] === result["CODIGO"]))
						return fail("TENANT_DUPLICATE_KEY");
					if (
						campaigns.some(
							(c) =>
								c["UNIDADE"] === id &&
								c["TIPO"] === result["TIPO"],
						)
					)
						return fail("TENANT_ORDERING_COMPOSITION_PENDING");
					return result;
				};
				if (command === "create") {
					const fields = object(body["fields"], unitFields) as Row;
					const id = number(fields["CODIGO"]);
					const description = text(fields["DESCRICAO"], 50);
					thresholds(fields);
					validate("unidades", fields);
					const duplicates = await tx.execute<Row[]>(
						"SELECT CODIGO FROM unidades WHERE DESCRICAO=? LIMIT 1 FOR UPDATE",
						[description],
					);
					if (
						units.some((u) => u["CODIGO"] === id) ||
						duplicates.length
					)
						return fail("TENANT_DUPLICATE_KEY");
					if (
						!Array.isArray(body["campaigns"]) ||
						body["campaigns"].length > 4
					)
						return fail();
					const prepared: Row[] = [];
					for (const raw of body["campaigns"]) {
						const row = prepare(raw, id);
						prepared.push(row);
						campaigns.push(row);
					}
					await insert(tx, "unidades", {
						...fields,
						DESCRICAO: description,
					});
					for (const row of prepared)
						await insert(tx, "campanhas", row);
					return { CODIGO: id };
				}
				if (command === "campaign-create") {
					const fields = object(
						body["fields"],
						campaignFields.filter(
							(k) =>
								![
									"SQL_CAMPANHA",
									"GERADO_LISTA",
									"PRIORIDADE",
								].includes(k),
						),
					);
					const id = number(fields["UNIDADE"]);
					if (!units.some((u) => u["CODIGO"] === id))
						return fail("TENANT_ORDERING_UNIT_UNAVAILABLE");
					const { UNIDADE: _, ...rest } = fields;
					const row = prepare(rest, id);
					await insert(tx, "campanhas", row);
					return row;
				}
				const current = campaigns.find((c) => c["CODIGO"] === unitId);
				if (!current) return fail("TENANT_ORDERING_UNIT_UNAVAILABLE");
				const expected = object(
					body["expected"],
					campaignFields.filter((k) => k !== "CODIGO"),
				) as Row;
				const changes = object(
					body["changes"],
					campaignFields.filter(
						(k) =>
							![
								"CODIGO",
								"SQL_CAMPANHA",
								"GERADO_LISTA",
								"PRIORIDADE",
							].includes(k),
					),
				) as Row;
				if (
					!Object.keys(changes).length ||
					Object.keys(expected).length !==
						campaignColumns.length - 1 ||
					!same(
						current,
						expected,
						campaignColumns
							.filter((c) => c.name !== "CODIGO")
							.map((c) => c.name),
					)
				)
					return fail("TENANT_ORDERING_CHANGED");
				if (
					["TIPO", "UNIDADE"].some(
						(k) =>
							Object.hasOwn(changes, k) &&
							changes[k] !== current[k],
					)
				)
					return fail("TENANT_ORDERING_COMPOSITION_PENDING");
				if (
					changes["PAUSADA"] === "NAO" &&
					current["PAUSADA"] !== "NAO"
				) {
					const linked = units.find(
						(u) => u["CODIGO"] === current["UNIDADE"],
					);
					if (
						!linked ||
						!complete(
							campaigns.filter(
								(c) => c["UNIDADE"] === linked["CODIGO"],
							),
						)
					)
						return fail("TENANT_ORDERING_COMPOSITION_PENDING");
					thresholds(linked);
				}
				if (Object.hasOwn(changes, "NOME")) text(changes["NOME"], 150);
				validate("campanhas", changes);
				await tx.execute(
					`UPDATE campanhas SET ${Object.keys(changes)
						.map((k) => `\`${k}\`=?`)
						.join(",")} WHERE CODIGO=?`,
					[...Object.values(changes), unitId],
				);
				return { ...current, ...changes };
			},
		);
	}
}
