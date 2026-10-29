import { createHash } from "node:crypto";
import type { TenantDatabase } from "../tenant-database/tenant-database";
import type { TenantTransaction } from "../tenant-database/transaction";
import { TenantDatabaseError } from "../tenant-database/error";
import { compileOrder, parseOrder, orderExpressions } from "./ordering";

type Row = Record<string, string | number | null>;
type Kind = "campaigns" | "segments" | "states" | "cities";
const specs = {
	campaigns: {
		table: "campanhas",
		key: "CODIGO",
		order: "PRIORIDADE",
		fields: [
			"CODIGO",
			"NOME",
			"DATA_INI",
			"MAX_RESPOSTA",
			"DESCRICAO",
			"PAUSADA",
			"PAUSAR_AG_PUBLICA",
			"TIPO",
			"UNIDADE",
			"OPERADOR",
		],
	},
	segments: {
		table: "segmentos",
		key: "CODIGO",
		order: "ordem",
		fields: ["NOME", "COD_UNIDADE"],
	},
	states: {
		table: "uf",
		key: "UF",
		order: "ORDEM",
		fields: ["UF", "NOME", "FUSOHORARIO"],
	},
	cities: {
		table: "cidades",
		key: "CODIGO",
		order: "ORDEM",
		fields: ["CODIGO", "NOME", "UF"],
	},
} as const;
const limit = 20000;
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
		Object.keys(input).some((key) => !keys.includes(key))
	)
		return fail();
	return input as Record<string, unknown>;
}
function scopeFor(kind: Kind, input: unknown): string {
	const scope = input ?? "all";
	if (
		typeof scope !== "string" ||
		(kind === "cities"
			? scope !== "national" && !/^[A-Z]{2}$/.test(scope)
			: scope !== "all")
	)
		return fail();
	return scope;
}
async function rows(
	tx: TenantTransaction,
	table: string,
	key: string,
	order = key,
): Promise<Row[]> {
	const data = await tx.execute<Row[]>(
		`SELECT * FROM \`${table}\` ORDER BY ${order} LIMIT ${limit + 1} FOR UPDATE`,
	);
	if (data.length > limit) return fail("TENANT_ORDERING_TOO_LARGE");
	if (
		data.some((row) =>
			key === "UF"
				? typeof row[key] !== "string"
				: !Number.isInteger(row[key]),
		)
	)
		return fail("TENANT_ORDERING_SCHEMA_UNAVAILABLE");
	return data;
}
async function policy(tx: TenantTransaction): Promise<Row> {
	const data = await tx.execute<Row[]>(
		"SELECT CODIGO,ORDERBY,SEQUENCIADEORDENACAO,ORDENACAO_APENAS_CIDADE FROM parametros ORDER BY CODIGO LIMIT 2 FOR UPDATE",
	);
	if (data.length !== 1) return fail("TENANT_ORDERING_POLICY_UNAVAILABLE");
	return data[0]!;
}
async function reviewed(tx: TenantTransaction, tables: string[]) {
	const triggers = await tx.execute<unknown[]>(
		`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN (${tables.map(() => "?").join(",")}) LIMIT 1`,
		tables,
	);
	if (triggers.length) fail("TENANT_TRANSACTION_UNREVIEWED_TRIGGERS");
}
function fingerprint(
	tenant: string,
	kind: Kind,
	scope: string,
	config: Row,
	data: Row[],
	states: Row[],
) {
	return createHash("sha256")
		.update(JSON.stringify([tenant, kind, scope, config, data, states]))
		.digest("hex");
}
function items(kind: Kind, scope: string, data: Row[], states: Row[]) {
	const spec = specs[kind],
		valid = new Set(states.map((row) => row["UF"]));
	return data
		.filter(
			(row) =>
				kind !== "cities" ||
				scope === "national" ||
				row["UF"] === scope,
		)
		.map((row, index) => ({
			id: row[spec.key],
			name: row["NOME"],
			position: index + 1,
			storedOrder:
				row[
					kind === "cities" && scope === "national"
						? "ORDEMCIDADE"
						: spec.order
				],
			...(kind === "cities"
				? { uf: row["UF"], validUf: valid.has(row["UF"]) }
				: {}),
			...(kind === "campaigns"
				? { paused: row["PAUSADA"] === "SIM" }
				: {}),
		}));
}
async function snapshot(
	tx: TenantTransaction,
	tenant: string,
	kind: Kind,
	scope: string,
	config: Row,
) {
	const spec = specs[kind],
		field =
			kind === "cities" && scope === "national"
				? "ORDEMCIDADE"
				: spec.order;
	const priority =
		kind === "segments" || kind === "states"
			? `IF(\`${field}\`>0,\`${field}\`,${kind === "states" ? 9999999 : 999999999})`
			: kind === "cities"
				? `COALESCE(\`${field}\`,999999999)`
				: `\`${field}\``;
	// Always lock the complete range, including rows outside a selected UF and insertion gaps.
	const data = await rows(
		tx,
		spec.table,
		spec.key,
		`${priority},NOME,\`${spec.key}\``,
	);
	const states = kind === "cities" ? await rows(tx, "uf", "UF") : [];
	if (
		kind === "cities" &&
		scope !== "national" &&
		!states.some((row) => row["UF"] === scope)
	)
		fail("TENANT_ORDERING_SCOPE_UNAVAILABLE");
	return {
		data,
		states,
		value: {
			kind,
			scope,
			revision: fingerprint(tenant, kind, scope, config, data, states),
			cityMode: config["ORDENACAO_APENAS_CIDADE"],
			items: items(kind, scope, data, states),
			states: states.map((row) => ({ id: row["UF"], name: row["NOME"] })),
			invalidUfCount:
				kind === "cities"
					? data.filter(
							(row) =>
								!states.some(
									(state) => state["UF"] === row["UF"],
								),
						).length
					: 0,
		},
	};
}
async function rank(
	tx: TenantTransaction,
	table: string,
	key: string,
	field: string,
	ids: (string | number)[],
) {
	for (let offset = 0; offset < ids.length; offset += 500) {
		const chunk = ids.slice(offset, offset + 500);
		await tx.execute(
			`UPDATE \`${table}\` SET \`${field}\`=CASE \`${key}\` ${chunk.map(() => "WHEN ? THEN ?").join(" ")} ELSE \`${field}\` END WHERE \`${key}\` IN (${chunk.map(() => "?").join(",")})`,
			[
				...chunk.flatMap((id, index) => [id, offset + index + 1]),
				...chunk,
			],
		);
	}
}
function next(
	data: Row[],
	field: string,
	missingRank = 0,
	positiveOnly = false,
) {
	const value =
		data.reduce((max, row) => {
			const raw = row[field];
			// Append after the effective SQL rank, including legacy NULL/nonpositive tails.
			const rank =
				raw === null || (positiveOnly && Number(raw) <= 0)
					? missingRank
					: Number(raw) || 0;
			return Math.max(max, rank);
		}, 0) + 1;
	if (value > 2147483647) fail("TENANT_ORDERING_OVERFLOW");
	return value;
}

export class CatalogOrderingService {
	constructor(
		private readonly database: Pick<TenantDatabase, "transaction">,
	) {}
	async execute(tenant: string, input: unknown): Promise<unknown> {
		const body = object(input, [
			"action",
			"kind",
			"scope",
			"revision",
			"ids",
			"fields",
			"criteria",
			"cityMode",
			"expected",
		]);
		if (body["action"] === "criteria") return this.criteria(tenant, body);
		if (
			typeof body["kind"] !== "string" ||
			!Object.hasOwn(specs, body["kind"])
		)
			return fail();
		const kind = body["kind"] as Kind,
			spec = specs[kind];
		const scope = scopeFor(
			kind,
			body["scope"] ?? (kind === "cities" ? "national" : "all"),
		);
		if (!["read", "save", "create"].includes(String(body["action"])))
			return fail();
		const allowed =
			body["action"] === "read"
				? ["action", "kind", "scope"]
				: body["action"] === "save"
					? ["action", "kind", "scope", "revision", "ids"]
					: ["action", "kind", "fields"];
		object(body, allowed);
		const tables = [
			...new Set([
				"parametros",
				spec.table,
				...(kind === "cities" || kind === "states"
					? ["uf", "cidades"]
					: []),
				...(kind === "segments" && body["action"] === "create"
					? ["unidades"]
					: []),
			]),
		];
		return this.database.transaction(
			tenant,
			`crm.catalog-ordering.${body["action"]}`,
			tables,
			async (tx) => {
				const config = await policy(tx);
				await reviewed(tx, tables);
				const before = await snapshot(tx, tenant, kind, scope, config);
				if (body["action"] === "read") return before.value;
				if (body["action"] === "create") {
					const fields = object(body["fields"], spec.fields) as Row;
					if (
						!Object.keys(fields).length ||
						Object.values(fields).some(
							(value) =>
								value !== null &&
								typeof value !== "string" &&
								!(
									typeof value === "number" &&
									Number.isFinite(value)
								),
						)
					)
						return fail();
					if (kind === "segments" && fields["COD_UNIDADE"] != null) {
						const units = await tx.execute<Row[]>(
							"SELECT CODIGO FROM unidades WHERE CODIGO=? FOR UPDATE",
							[fields["COD_UNIDADE"]],
						);
						if (units.length !== 1)
							return fail("TENANT_ORDERING_UNIT_UNAVAILABLE");
					}
					if (
						kind === "cities" &&
						fields["UF"] != null &&
						!before.states.some(
							(state) => state["UF"] === fields["UF"],
						)
					)
						return fail("TENANT_ORDERING_SCOPE_UNAVAILABLE");
					const values: Row = {
						...fields,
						[spec.order]: next(
							kind === "cities"
								? before.data.filter(
										(row) => row["UF"] === fields["UF"],
									)
								: before.data,
							spec.order,
							kind === "states"
								? 9999999
								: kind === "campaigns"
									? 0
									: 999999999,
							kind === "states" || kind === "segments",
						),
					};
					if (kind === "cities") {
						values["ORDEMCIDADE"] = next(
							before.data,
							"ORDEMCIDADE",
							999999999,
						);
						values["ORDEMESTADO"] =
							before.states.find(
								(row) => row["UF"] === fields["UF"],
							)?.["ORDEM"] ?? null;
					}
					const keys = Object.keys(values);
					const result = await tx.execute<{
						insertId: number;
						affectedRows: number;
					}>(
						`INSERT INTO \`${spec.table}\` (${keys.map((key) => `\`${key}\``).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
						Object.values(values),
					);
					if (result.affectedRows !== 1)
						return fail("TENANT_TRANSACTION_AFFECTED_ROWS");
					return {
						id:
							kind === "segments"
								? result.insertId
								: values[spec.key],
					};
				}
				if (
					typeof body["revision"] !== "string" ||
					!/^[a-f0-9]{64}$/.test(body["revision"]) ||
					!Array.isArray(body["ids"]) ||
					body["ids"].length > limit ||
					body["ids"].some((id) =>
						kind === "states"
							? typeof id !== "string" || !/^[A-Z]{2}$/.test(id)
							: !Number.isInteger(id) ||
								id < -2147483648 ||
								id > 2147483647,
					) ||
					new Set(body["ids"]).size !== body["ids"].length
				)
					return fail();
				if (body["revision"] !== before.value.revision)
					return fail("TENANT_ORDERING_CHANGED");
				const expectedIds = new Set(
					before.value.items.map((item) => item.id),
				);
				if (
					expectedIds.size !== body["ids"].length ||
					body["ids"].some((id) => !expectedIds.has(id))
				)
					return fail("TENANT_ORDERING_CHANGED");
				await rank(
					tx,
					spec.table,
					spec.key,
					kind === "cities" && scope === "national"
						? "ORDEMCIDADE"
						: spec.order,
					body["ids"],
				);
				if (kind === "states") {
					await rows(tx, "cidades", "CODIGO");
					await tx.execute(
						"UPDATE cidades c LEFT JOIN uf u ON u.UF=c.UF SET c.ORDEMESTADO=u.ORDEM",
					);
				}
				return (await snapshot(tx, tenant, kind, scope, config)).value;
			},
		);
	}
	private async criteria(tenant: string, body: Record<string, unknown>) {
		object(body, ["action", "criteria", "cityMode", "expected"]);
		let criteria;
		try {
			criteria = parseOrder(body["criteria"]);
		} catch {
			return fail();
		}
		if (body["cityMode"] !== "S" && body["cityMode"] !== "N") return fail();
		const expected = object(body["expected"], [
			"CODIGO",
			"ORDERBY",
			"SEQUENCIADEORDENACAO",
			"ORDENACAO_APENAS_CIDADE",
		]);
		const sql = compileOrder(criteria, body["cityMode"]),
			sequence = criteria.join(",");
		return this.database.transaction(
			tenant,
			"crm.catalog-ordering.criteria",
			["parametros"],
			async (tx) => {
				const current = await policy(tx);
				await reviewed(tx, ["parametros"]);
				if (
					Object.keys(current).some(
						(key) => current[key] !== expected[key],
					)
				)
					return fail("TENANT_ORDERING_CHANGED");
				await tx.execute(
					"UPDATE parametros SET ORDERBY=?,SEQUENCIADEORDENACAO=?,ORDENACAO_APENAS_CIDADE=? WHERE CODIGO=?",
					[sql, sequence, body["cityMode"], current["CODIGO"]],
				);
				return {
					data: {
						...current,
						ORDERBY: sql,
						SEQUENCIADEORDENACAO: sequence,
						ORDENACAO_APENAS_CIDADE: body["cityMode"],
					},
					criteria,
					supportedCriteria: Object.keys(orderExpressions),
					managed: true,
				};
			},
		);
	}
}
