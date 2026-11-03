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
function nextCode(rows: Row[]) {
	return number(
		rows.reduce(
			(max, row) => Math.max(max, Number(row["CODIGO"]) || 0),
			0,
		) + 1,
	);
}
type Reason = { code: string; message: string };
const capability = (reasons: Reason[] = []) => ({
	allowed: reasons.length === 0,
	reasons,
});
function periodReasons(unit: Row): Reason[] {
	try {
		thresholds(unit);
		return [];
	} catch {
		return [
			{
				code: "UNIT_PERIODS_INVALID",
				message:
					"Os períodos da unidade precisam ser válidos: o limite de inativos recentes deve ser menor que o de antigos.",
			},
		];
	}
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
		if (
			input &&
			typeof input === "object" &&
			!Array.isArray(input) &&
			(input as Record<string, unknown>)["action"] === "units" &&
			(input as Record<string, unknown>)["command"] === "member-create"
		)
			return this.createMember(tenant, input);
		const body = object(input, [
			"action",
			"command",
			"id",
			"fields",
			"campaigns",
			"changes",
			"expected",
			"operationMode",
			"organizationalUnitId",
		]);
		if (body["action"] !== "units") return fail();
		const command = body["command"];
		const permitted: Record<string, string[]> = {
			list: ["action", "command"],
			detail: ["action", "command", "id"],
			"campaign-context": ["action", "command", "id"],
			create: ["action", "command", "fields", "campaigns"],
			patch: ["action", "command", "id", "changes", "expected"],
			"campaign-create": [
				"action",
				"command",
				"fields",
				"operationMode",
				"organizationalUnitId",
			],
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
		const writing = !["list", "detail", "campaign-context"].includes(
			command,
		);
		return this.database.transaction(
			tenant,
			"crm.catalog-ordering.units",
			["parametros", "unidades", "campanhas", "crm_campaign_policies"],
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
					"SELECT TABLE_NAME AS tableName,COLUMN_NAME AS name,COLUMN_TYPE AS type,CHARACTER_MAXIMUM_LENGTH AS maxLength,IS_NULLABLE AS nullable,COLUMN_DEFAULT AS defaultValue,EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('unidades','campanhas','crm_campaign_policies') ORDER BY ORDINAL_POSITION",
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
					[
						"crm_campaign_policies",
						[
							"CAMPAIGN_ID",
							"UNIT_ID",
							"OPERATION_MODE",
							"OVERLAP_POLICY",
							"ASSIGNMENT_POLICY",
							"CHANGE_EFFECT",
						],
					],
				] as const) {
					if (
						required.some(
							(k) =>
								!columns.some(
									(c) =>
										c.tableName === table &&
										c.name.toUpperCase() === k,
								),
						)
					)
						return fail("TENANT_ORDERING_SCHEMA_UNAVAILABLE");
				}
				// A missing/changed tenant column never causes fallback to a different schema.
				for (const column of columns)
					column.name = column.name.toUpperCase();
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
				const policies = await tx.execute<Row[]>(
					"SELECT campaign_id,unit_id,operation_mode,overlap_policy,assignment_policy,change_effect FROM crm_campaign_policies ORDER BY campaign_id LIMIT 20001 FOR UPDATE",
				);
				if (
					policies.length > 20000 ||
					policies.some(
						(p) =>
							p["operation_mode"] !== "audience_manual" ||
							p["overlap_policy"] !== "allow" ||
							p["assignment_policy"] !== "explicit_operator" ||
							p["change_effect"] !== "future_batches" ||
							!campaigns.some(
								(c) =>
									c["CODIGO"] === p["campaign_id"] &&
									c["UNIDADE"] == null &&
									c["TIPO"] == null,
							) ||
							!units.some((u) => u["CODIGO"] === p["unit_id"]),
					)
				)
					return fail("TENANT_ORDERING_SCHEMA_UNAVAILABLE");
				const policyFor = (campaign: Row) =>
					policies.find(
						(p) => p["campaign_id"] === campaign["CODIGO"],
					);
				const unitFor = (campaign: Row) =>
					units.find(
						(u) =>
							u["CODIGO"] ===
							(policyFor(campaign)?.["unit_id"] ??
								campaign["UNIDADE"]),
					);
				const associated = (unit: Row) =>
					campaigns.filter(
						(c) => unitFor(c)?.["CODIGO"] === unit["CODIGO"],
					);
				const cycle = (unit: Row) =>
					campaigns.filter((c) => c["UNIDADE"] === unit["CODIGO"]);
				const cycleReasons = (unit: Row): Reason[] => [
					...(!complete(cycle(unit))
						? [
								{
									code: "CYCLE_COMPOSITION_INCOMPLETE",
									message:
										"Complete as quatro campanhas do ciclo de compra para retomar suas campanhas automáticas.",
								},
							]
						: []),
					...periodReasons(unit),
				];
				const renameUnitReasons = (unit: Row): Reason[] =>
					cycle(unit).some(
						(c) =>
							c["NOME"] === `${unit["DESCRICAO"]} - ${c["TIPO"]}`,
					)
						? [
								{
									code: "LEGACY_NAME_DEPENDENCY",
									message:
										"Esta unidade tem campanhas com nomes usados pelo legado. A alteração exige migração desses consumidores.",
								},
							]
						: [];
				const mode = (campaign: Row) =>
					policyFor(campaign)
						? "audience-manual"
						: campaign["UNIDADE"] != null
							? "purchase-cycle"
							: "legacy-unassigned";
				const campaignCapabilities = (campaign: Row) => {
					const linked = unitFor(campaign);
					const resumeReasons = policyFor(campaign)
						? []
						: linked
							? cycleReasons(linked)
							: [
									{
										code: "UNIT_UNAVAILABLE",
										message:
											"A campanha não possui unidade e política operacional válidas para retomada.",
									},
								];
					const managed =
						typeof campaign["SQL_CAMPANHA"] === "string" &&
						campaign["SQL_CAMPANHA"].startsWith(
							"/* inpulse-crm-selection-v1:",
						);
					return {
						edit: capability(),
						rename: capability(
							!policyFor(campaign) &&
								linked &&
								campaign["NOME"] ===
									`${linked["DESCRICAO"]} - ${campaign["TIPO"]}`
								? [
										{
											code: "LEGACY_NAME_DEPENDENCY",
											message:
												"O nome desta campanha é usado por consumidores legados. A alteração exige migração desses consumidores.",
										},
									]
								: [],
						),
						resume: capability(resumeReasons),
						pause: capability(),
						generate: capability(
							managed
								? []
								: [
										{
											code: "PUBLIC_NOT_MANAGED",
											message:
												"Salve um público estruturado na seção Público antes de preparar um lote. SQL legado não será convertido automaticamente.",
										},
									],
						),
					};
				};
				const view = (unit: Row) => {
					const cycleCount = cycle(unit).length,
						manualCount = associated(unit).filter((c) =>
							policyFor(c),
						).length;
					return {
						...unit,
						campaignCount: associated(unit).length,
						cycleCampaignCount: cycleCount,
						manualCampaignCount: manualCount,
						activationAvailable: cycleReasons(unit).length === 0,
						mode: cycleCount
							? manualCount
								? "mixed"
								: "purchase-cycle"
							: manualCount
								? "audience-manual"
								: "unconfigured",
						missingTypes: campaignTypes.filter(
							(t) => !cycle(unit).some((c) => c["TIPO"] === t),
						),
						pendingReasons: cycleCount ? cycleReasons(unit) : [],
						capabilities: {
							rename: capability(renameUnitReasons(unit)),
						},
					};
				};
				if (command === "list")
					return {
						data: units.map(view),
						supportedTypes: campaignTypes,
					};
				if (writing) {
					const keys = await tx.execute<
						{ tableName: string; name: string }[]
					>(
						"SELECT TABLE_NAME AS tableName,COLUMN_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('unidades','campanhas','crm_campaign_policies') AND INDEX_NAME='PRIMARY' ORDER BY TABLE_NAME,SEQ_IN_INDEX",
					);
					if (
						["unidades", "campanhas", "crm_campaign_policies"].some(
							(t) =>
								keys.filter((k) => k.tableName === t).length !==
									1 ||
								!keys.some(
									(k) =>
										k.tableName === t &&
										k.name.toUpperCase() ===
											(t === "crm_campaign_policies"
												? "CAMPAIGN_ID"
												: "CODIGO"),
								),
						)
					)
						return fail("TENANT_ORDERING_SCHEMA_UNAVAILABLE");
					const triggers = await tx.execute<unknown[]>(
						"SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN ('unidades','campanhas','crm_campaign_policies') LIMIT 1",
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
						data: view(unit),
						campaigns: associated(unit),
						campaignModes: Object.fromEntries(
							associated(unit).map((c) => [
								String(c["CODIGO"]),
								mode(c),
							]),
						),
						supportedTypes: campaignTypes,
					};
				}
				if (command === "campaign-context") {
					const campaign = campaigns.find(
						(c) => c["CODIGO"] === unitId,
					);
					if (!campaign)
						return fail("TENANT_ORDERING_UNIT_UNAVAILABLE");
					const linked = unitFor(campaign);
					return {
						campaign,
						unit: linked ? view(linked) : null,
						operationMode: mode(campaign),
						policy: policyFor(campaign) ?? null,
						capabilities: campaignCapabilities(campaign),
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
					if (
						next !== unit["DESCRICAO"] &&
						renameUnitReasons(unit).length
					)
						return fail("TENANT_ORDERING_LEGACY_NAME_DEPENDENCY");
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
				const prepare = (
					raw: unknown,
					id: number,
					unitDescription: string,
				): Row => {
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
					fields["CODIGO"] =
						fields["CODIGO"] === undefined
							? nextCode(campaigns)
							: number(fields["CODIGO"]);
					if (
						!campaignTypes.includes(
							fields["TIPO"] as (typeof campaignTypes)[number],
						)
					)
						return fail();
					const canonicalName = `${unitDescription} - ${fields["TIPO"]}`;
					if (
						fields["NOME"] !== undefined &&
						text(fields["NOME"], 150) !== canonicalName
					)
						return fail("TENANT_ORDERING_LEGACY_NAME_REQUIRED");
					fields["NOME"] = text(canonicalName, 150);
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
					const id =
						fields["CODIGO"] === undefined
							? nextCode(units)
							: number(fields["CODIGO"]);
					fields["CODIGO"] = id;
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
					const initialCampaigns = body["campaigns"] ?? [];
					if (
						!Array.isArray(initialCampaigns) ||
						initialCampaigns.length > 4
					)
						return fail();
					const prepared: Row[] = [];
					for (const raw of initialCampaigns) {
						const row = prepare(raw, id, description);
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
					if (body["operationMode"] === "audience-manual") {
						const id = number(body["organizationalUnitId"]);
						if (!units.some((u) => u["CODIGO"] === id))
							return fail("TENANT_ORDERING_UNIT_UNAVAILABLE");
						if (
							fields["UNIDADE"] != null ||
							fields["TIPO"] != null ||
							(fields["PAUSADA"] !== undefined &&
								fields["PAUSADA"] !== "SIM")
						)
							return fail();
						const row: Row = {
							...(fields as Row),
							CODIGO:
								fields["CODIGO"] === undefined
									? nextCode(campaigns)
									: number(fields["CODIGO"]),
							NOME: text(fields["NOME"], 150),
							UNIDADE: null,
							TIPO: null,
							PAUSADA: "SIM",
							PRIORIDADE: number(
								campaigns.reduce(
									(n, c) =>
										Math.max(
											n,
											Number(c["PRIORIDADE"]) || 0,
										),
									0,
								) + 1,
							),
						};
						for (const column of campaignColumns)
							if (
								column.type === "datetime" &&
								column.nullable === "YES" &&
								String(column.defaultValue).startsWith(
									"0000-",
								) &&
								!Object.hasOwn(row, column.name)
							)
								row[column.name] = null;
						validate("campanhas", row);
						await insert(tx, "campanhas", row);
						await tx.execute(
							"INSERT INTO crm_campaign_policies (campaign_id,unit_id,operation_mode,overlap_policy,assignment_policy,change_effect) VALUES (?,?,'audience_manual','allow','explicit_operator','future_batches')",
							[row["CODIGO"], id],
						);
						return row;
					}
					if (
						body["operationMode"] !== undefined ||
						body["organizationalUnitId"] !== undefined
					)
						return fail();
					const id = number(fields["UNIDADE"]);
					if (!units.some((u) => u["CODIGO"] === id))
						return fail("TENANT_ORDERING_UNIT_UNAVAILABLE");
					const { UNIDADE: _, ...rest } = fields;
					const row = prepare(
						rest,
						id,
						String(
							units.find((u) => u["CODIGO"] === id)!["DESCRICAO"],
						),
					);
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
					if (!policyFor(current)) {
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
				}
				if (Object.hasOwn(changes, "NOME")) {
					text(changes["NOME"], 150);
					if (
						changes["NOME"] !== current["NOME"] &&
						!campaignCapabilities(current).rename.allowed
					)
						return fail("TENANT_ORDERING_LEGACY_NAME_DEPENDENCY");
				}
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
	private async createMember(tenant: string, input: unknown) {
		const body = object(input, ["action", "command", "id", "fields"]),
			campaign = number(body["id"]),
			fields = object(body["fields"], ["OPERADOR"]),
			operator = number(fields["OPERADOR"]);
		return this.database.transaction(
			tenant,
			"crm.catalog-ordering.member-create",
			["parametros", "campanhas", "campanhasxoperadores", "operadores"],
			async (tx) => {
				const policy = await tx.execute<Row[]>(
					"SELECT CODIGO FROM parametros ORDER BY CODIGO LIMIT 2 FOR UPDATE",
				);
				if (policy.length !== 1)
					return fail("TENANT_ORDERING_POLICY_UNAVAILABLE");
				const keys = await tx.execute<{ name: string }[]>(
					"SELECT COLUMN_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campanhasxoperadores' AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX",
				);
				if (
					keys.length !== 1 ||
					keys[0]!.name.toUpperCase() !== "CODIGO"
				)
					return fail("TENANT_ORDERING_SCHEMA_UNAVAILABLE");
				const triggers = await tx.execute<unknown[]>(
					"SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='campanhasxoperadores' LIMIT 1",
				);
				if (triggers.length)
					return fail("TENANT_TRANSACTION_UNREVIEWED_TRIGGERS");
				const campaigns = await tx.execute<Row[]>(
					"SELECT CODIGO FROM campanhas WHERE CODIGO=? LIMIT 1 FOR UPDATE",
					[campaign],
				);
				const operators = await tx.execute<Row[]>(
					"SELECT CODIGO FROM operadores WHERE CODIGO=? AND ATIVO='SIM' LIMIT 1 FOR UPDATE",
					[operator],
				);
				if (campaigns.length !== 1 || operators.length !== 1)
					return fail("TENANT_ORDERING_UNIT_UNAVAILABLE");
				const members = await tx.execute<Row[]>(
					"SELECT CODIGO,CAMPANHA,OPERADOR FROM campanhasxoperadores ORDER BY CODIGO LIMIT 20001 FOR UPDATE",
				);
				if (members.length > 20000)
					return fail("TENANT_ORDERING_TOO_LARGE");
				if (
					members.some(
						(m) =>
							m["CAMPANHA"] === campaign &&
							m["OPERADOR"] === operator,
					)
				)
					return fail("TENANT_DUPLICATE_KEY");
				const id = nextCode(members);
				const result = await tx.execute<{ affectedRows: number }>(
					"INSERT INTO campanhasxoperadores (CODIGO,CAMPANHA,OPERADOR) VALUES (?,?,?)",
					[id, campaign, operator],
				);
				if (result.affectedRows !== 1)
					return fail("TENANT_TRANSACTION_AFFECTED_ROWS");
				return { CODIGO: id, CAMPANHA: campaign, OPERADOR: operator };
			},
		);
	}
}
