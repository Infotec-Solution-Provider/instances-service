const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CrmUnitsService } = require("../dist/crm-units/service");
const { CatalogOrderingService } = require("../dist/catalog-ordering/service");

const unit = {
	CODIGO: 1,
	DESCRICAO: "Matriz",
	INATIVOS_RECENTES: 90,
	INATIVOS_ANTIGOS: 180,
};
const fields = {
	CODIGO: 2,
	DESCRICAO: "Nova unidade",
	INATIVOS_RECENTES: 30,
	INATIVOS_ANTIGOS: 90,
};
const campaign = {
	CODIGO: 11,
	NOME: "Nova unidade - PROSPE",
	TIPO: "PROSPE",
	MAX_RESPOSTA: 300,
	PAUSADA: "SIM",
};
function fixture(
	defaults = { INATIVOS_RECENTES: "180", INATIVOS_ANTIGOS: "365" },
) {
	let state = { units: [structuredClone(unit)], campaigns: [], policies: [] },
		failInsert = false,
		missing = false,
		triggers = false;
	const calls = [],
		contexts = [];
	const metadata = (tableName, specs) =>
		Object.entries(specs).map(([name, type]) => ({
			tableName,
			name,
			type,
			nullable: "YES",
			maxLength: 150,
			defaultValue:
				tableName === "unidades" && Object.hasOwn(defaults, name)
					? defaults[name]
					: type === "datetime"
						? "0000-00-00 00:00:00"
						: null,
		}));
	const columns = [
		...metadata("unidades", {
			CODIGO: "int",
			DESCRICAO: "varchar(50)",
			INATIVOS_RECENTES: "int",
			INATIVOS_ANTIGOS: "int",
		}),
		...metadata("campanhas", {
			CODIGO: "int",
			NOME: "varchar(150)",
			TIPO: "enum('ATIVOS','INAT_R','INAT_A','PROSPE')",
			UNIDADE: "int",
			PAUSADA: "enum('SIM','NAO')",
			PRIORIDADE: "int",
			MAX_RESPOSTA: "int",
			DATA_INI: "datetime",
		}),
		...metadata("crm_campaign_policies", {
			campaign_id: "int",
			unit_id: "int",
			operation_mode: "enum('audience_manual')",
			overlap_policy: "enum('allow')",
			assignment_policy: "enum('explicit_operator')",
			change_effect: "enum('future_batches')",
		}),
	];
	let queue = Promise.resolve();
	const database = {
		transaction: (tenant, operation, tables, work) => {
			const pending = queue.then(async () => {
				contexts.push({ tenant, operation, tables });
				const draft = structuredClone(state);
				const result = await work({
					tenant,
					execute: async (sql, params = []) => {
						calls.push({ sql, params });
						if (sql.includes("FROM parametros"))
							return [{ CODIGO: 1 }];
						if (sql.includes("information_schema.COLUMNS"))
							return missing ? [] : columns;
						if (sql.includes("information_schema.STATISTICS"))
							return [
								"unidades",
								"campanhas",
								"crm_campaign_policies",
							].map((tableName) => ({
								tableName,
								name:
									tableName === "crm_campaign_policies"
										? "campaign_id"
										: "CODIGO",
							}));
						if (sql.includes("information_schema.TRIGGERS"))
							return triggers ? [{ name: "unknown" }] : [];
						if (sql.includes("WHERE DESCRICAO=?"))
							return draft.units.filter(
								(u) =>
									u.DESCRICAO.toLowerCase() ===
										params[0].toLowerCase() &&
									(params.length === 1 ||
										u.CODIGO !== params[1]),
							);
						if (sql.includes("FROM unidades ORDER BY"))
							return structuredClone(draft.units);
						if (sql.includes("FROM campanhas ORDER BY"))
							return structuredClone(draft.campaigns);
						if (sql.includes("FROM crm_campaign_policies ORDER BY"))
							return structuredClone(draft.policies);
						if (
							sql.startsWith("INSERT INTO crm_campaign_policies")
						) {
							draft.policies.push({
								campaign_id: params[0],
								unit_id: params[1],
								operation_mode: "audience_manual",
								overlap_policy: "allow",
								assignment_policy: "explicit_operator",
								change_effect: "future_batches",
							});
							return { affectedRows: 1 };
						}
						if (sql.startsWith("INSERT INTO")) {
							const table = sql.includes("`unidades`")
								? "units"
								: "campaigns";
							if (table === "campaigns" && failInsert)
								throw new Error("synthetic insert failure");
							const keys = [
								...sql
									.slice(sql.indexOf("("), sql.indexOf(")"))
									.matchAll(/`([^`]+)`/g),
							].map((m) => m[1]);
							draft[table].push(
								Object.fromEntries(
									keys.map((k, i) => [k, params[i]]),
								),
							);
							return { affectedRows: 1 };
						}
						if (sql.startsWith("UPDATE unidades")) {
							draft.units.find(
								(u) => u.CODIGO === params[1],
							).DESCRICAO = params[0];
							return { affectedRows: 1 };
						}
						if (sql.startsWith("UPDATE campanhas")) {
							const keys = [
								...sql
									.slice(0, sql.indexOf("WHERE"))
									.matchAll(/`([^`]+)`/g),
							].map((m) => m[1]);
							Object.assign(
								draft.campaigns.find(
									(c) => c.CODIGO === params.at(-1),
								),
								Object.fromEntries(
									keys.map((k, i) => [k, params[i]]),
								),
							);
							return { affectedRows: 1 };
						}
						throw new Error("Unexpected fixture SQL: " + sql);
					},
				});
				state = draft;
				return result;
			});
			queue = pending.catch(() => {});
			return pending;
		},
	};
	const service = new CrmUnitsService(database);
	return {
		service,
		database,
		calls,
		contexts,
		get state() {
			return state;
		},
		set failure(v) {
			failInsert = v;
		},
		set missing(v) {
			missing = v;
		},
		set triggers(v) {
			triggers = v;
		},
	};
}
const run = (f, command, body = {}) =>
	f.service.execute("tenant-a", { action: "units", command, ...body });
test("unit creation persists only selected campaigns, appends priority and never rewrites existing units", async () => {
	const f = fixture();
	await new CatalogOrderingService(f.database).execute("tenant-a", {
		action: "units",
		command: "create",
		fields,
		campaigns: [campaign],
	});
	assert.deepEqual(f.state.units[0], unit);
	assert.equal(f.state.campaigns.length, 1);
	assert.deepEqual(f.state.campaigns[0], {
		...campaign,
		UNIDADE: 2,
		PRIORIDADE: 1,
		DATA_INI: null,
	});
	assert.deepEqual(f.contexts[0], {
		tenant: "tenant-a",
		operation: "crm.catalog-ordering.units",
		tables: [
			"parametros",
			"unidades",
			"campanhas",
			"crm_campaign_policies",
		],
	});
	assert(
		f.calls
			.filter((c) => /FROM (unidades|campanhas) ORDER BY/.test(c.sql))
			.every((c) => c.sql.endsWith("FOR UPDATE")),
	);
	const detail = await run(f, "detail", { id: 2 });
	assert.equal(detail.campaigns[0].NOME, "Nova unidade - PROSPE");
});
test("empty composition is allowed and no implicit campaigns are inserted", async () => {
	const f = fixture();
	await run(f, "create", { fields, campaigns: [] });
	assert.equal(f.state.campaigns.length, 0);
});
test("rolls back the entire bundle when a campaign insertion fails", async () => {
	const f = fixture();
	f.failure = true;
	await assert.rejects(run(f, "create", { fields, campaigns: [campaign] }));
	assert.equal(f.state.units.length, 1);
	assert.equal(f.state.campaigns.length, 0);
});
test("rejects duplicate semantic types, unsupported types, new active campaigns and invalid thresholds before INSERT", async () => {
	for (const body of [
		{ campaigns: [campaign, { ...campaign, CODIGO: 12 }] },
		{ campaigns: [{ ...campaign, TIPO: "CUSTOM" }] },
		{ campaigns: [{ ...campaign, PAUSADA: "NAO" }] },
		{ fields: { ...fields, INATIVOS_RECENTES: 100 } },
		{ fields: { ...fields, INATIVOS_ANTIGOS: null } },
	]) {
		const f = fixture();
		await assert.rejects(
			run(f, "create", { fields, campaigns: [campaign], ...body }),
		);
		assert.equal(
			f.calls.filter((c) => c.sql.startsWith("INSERT")).length,
			0,
		);
	}
});
test("schema/triggers fail closed and input cannot introduce SQL or a caller tenant", async () => {
	for (const flag of ["missing", "triggers"]) {
		const f = fixture();
		f[flag] = true;
		await assert.rejects(run(f, "create", { fields, campaigns: [] }));
		assert.equal(
			f.calls.filter((c) => c.sql.startsWith("INSERT")).length,
			0,
		);
	}
	const f = fixture();
	await assert.rejects(
		run(f, "create", { fields, campaigns: [], tenant: "tenant-b" }),
	);
	await assert.rejects(run(f, "sql", { sql: "UPDATE unidades" }));
	assert.equal(f.contexts.length, 0);
});
test("concurrent additions of the same unit/type yield one winner and no duplicate composition", async () => {
	const f = fixture();
	const results = await Promise.allSettled([
		run(f, "campaign-create", {
			fields: { ...campaign, NOME: "Matriz - PROSPE", UNIDADE: 1 },
		}),
		run(f, "campaign-create", {
			fields: {
				...campaign,
				NOME: "Matriz - PROSPE",
				CODIGO: 12,
				UNIDADE: 1,
			},
		}),
	]);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(f.state.campaigns.length, 1);
});
test("name compatibility, full CAS and composition gates preserve legacy semantics", async () => {
	const f = fixture();
	await run(f, "create", { fields, campaigns: [campaign] });
	const { CODIGO, ...expected } = f.state.campaigns[0];
	await assert.rejects(
		run(f, "campaign-patch", {
			id: CODIGO,
			changes: { NOME: "Nome comercial livre" },
			expected,
		}),
		{ code: "TENANT_ORDERING_LEGACY_NAME_DEPENDENCY" },
	);
	await run(f, "campaign-patch", {
		id: CODIGO,
		changes: { MAX_RESPOSTA: 60 },
		expected,
	});
	assert.equal(f.state.campaigns[0].TIPO, "PROSPE");
	await assert.rejects(
		run(f, "campaign-patch", {
			id: CODIGO,
			changes: { NOME: "stale" },
			expected,
		}),
		{ code: "TENANT_ORDERING_CHANGED" },
	);
	const { CODIGO: _, ...updated } = f.state.campaigns[0];
	for (const changes of [
		{ TIPO: "ATIVOS" },
		{ UNIDADE: 1 },
		{ PAUSADA: "NAO" },
	])
		await assert.rejects(
			run(f, "campaign-patch", {
				id: CODIGO,
				changes,
				expected: updated,
			}),
			{ code: "TENANT_ORDERING_COMPOSITION_PENDING" },
		);
});
test("legacy quartet can resume after explicit pause and unit rename does not rebuild campaigns", async () => {
	const f = fixture();
	await run(f, "create", {
		fields,
		campaigns: ["ATIVOS", "INAT_R", "INAT_A", "PROSPE"].map((TIPO, i) => ({
			...campaign,
			CODIGO: 20 + i,
			TIPO,
			NOME: `Nova unidade - ${TIPO}`,
		})),
	});
	const { CODIGO, ...expected } = f.state.campaigns[0];
	await run(f, "campaign-patch", {
		id: CODIGO,
		changes: { PAUSADA: "NAO" },
		expected,
	});
	const before = structuredClone(f.state.campaigns);
	await assert.rejects(
		run(f, "patch", {
			id: 2,
			changes: { DESCRICAO: "Renomeada" },
			expected: fields,
		}),
		{ code: "TENANT_ORDERING_LEGACY_NAME_DEPENDENCY" },
	);
	assert.deepEqual(f.state.campaigns, before);
	assert.equal(f.state.units[1].INATIVOS_RECENTES, 30);
});

test("automatic IDs serialize concurrent short unit creation and never require a browser counter", async () => {
	const f = fixture();
	const create = (DESCRICAO) =>
		run(f, "create", {
			fields: { DESCRICAO, INATIVOS_RECENTES: 30, INATIVOS_ANTIGOS: 90 },
		});
	const results = await Promise.all([
		create("Unidade A"),
		create("Unidade B"),
	]);
	assert.deepEqual(
		results.map((r) => r.CODIGO),
		[2, 3],
	);
	assert.equal(f.state.campaigns.length, 0);
});

test("name-only unit creation uses verified tenant defaults, preserves explicit periods and fails closed without valid defaults", async () => {
	const f = fixture({ INATIVOS_RECENTES: "120", INATIVOS_ANTIGOS: "240" });
	await run(f, "create", { fields: { DESCRICAO: "Somente nome" } });
	assert.deepEqual(f.state.units[1], {
		CODIGO: 2,
		DESCRICAO: "Somente nome",
		INATIVOS_RECENTES: 120,
		INATIVOS_ANTIGOS: 240,
	});
	await run(f, "create", {
		fields: {
			DESCRICAO: "Períodos próprios",
			INATIVOS_RECENTES: 15,
			INATIVOS_ANTIGOS: 45,
		},
	});
	assert.equal(f.state.units[2].INATIVOS_RECENTES, 15);
	assert.equal(f.state.units[2].INATIVOS_ANTIGOS, 45);
	assert.deepEqual(f.state.units[0], unit);
	for (const defaults of [
		{ INATIVOS_RECENTES: null, INATIVOS_ANTIGOS: "365" },
		{ INATIVOS_RECENTES: "(180)", INATIVOS_ANTIGOS: "365" },
		{ INATIVOS_RECENTES: "0", INATIVOS_ANTIGOS: "365" },
		{ INATIVOS_RECENTES: "365", INATIVOS_ANTIGOS: "180" },
	]) {
		const invalid = fixture(defaults);
		await assert.rejects(
			run(invalid, "create", { fields: { DESCRICAO: "Não gravar" } }),
		);
		assert.equal(
			invalid.calls.filter((call) => call.sql.startsWith("INSERT"))
				.length,
			0,
		);
	}
});

test("supplemental audience campaigns exceed four, resume without quartet, and keep authoritative policy independent of legacy type", async () => {
	const f = fixture();
	for (let i = 0; i < 6; i++)
		await run(f, "campaign-create", {
			operationMode: "audience-manual",
			organizationalUnitId: 1,
			fields: { NOME: `Público ${i}`, MAX_RESPOSTA: 0 },
		});
	assert.equal(f.state.campaigns.length, 6);
	assert.equal(f.state.policies.length, 6);
	assert.equal(new Set(f.state.campaigns.map((c) => c.CODIGO)).size, 6);
	assert(
		f.state.campaigns.every(
			(c) => c.UNIDADE === null && c.TIPO === null && c.PAUSADA === "SIM",
		),
	);
	const detail = await run(f, "detail", { id: 1 });
	assert.equal(detail.data.manualCampaignCount, 6);
	assert.equal(detail.data.mode, "audience-manual");
	assert.deepEqual(detail.data.pendingReasons, []);
	const context = await run(f, "campaign-context", { id: 1 });
	assert.equal(context.operationMode, "audience-manual");
	assert.equal(context.unit.CODIGO, 1);
	assert.equal(context.capabilities.resume.allowed, true);
	const { CODIGO, ...expected } = context.campaign;
	await run(f, "campaign-patch", {
		id: CODIGO,
		changes: { NOME: "Nome livre", PAUSADA: "NAO" },
		expected,
	});
	assert.equal(f.state.campaigns[0].PAUSADA, "NAO");
	assert.equal(f.state.policies[0].change_effect, "future_batches");
	await assert.rejects(
		run(f, "campaign-create", {
			operationMode: "audience-manual",
			organizationalUnitId: 1,
			fields: { NOME: "Inválida", UNIDADE: 1, TIPO: "PROSPE" },
		}),
	);
});
