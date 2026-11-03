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
	NOME: "Clientes novos",
	TIPO: "PROSPE",
	MAX_RESPOSTA: 300,
	PAUSADA: "SIM",
};
function fixture() {
	let state = { units: [structuredClone(unit)], campaigns: [] },
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
			defaultValue: type === "datetime" ? "0000-00-00 00:00:00" : null,
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
							return ["unidades", "campanhas"].map(
								(tableName) => ({ tableName, name: "CODIGO" }),
							);
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
		tables: ["parametros", "unidades", "campanhas"],
	});
	assert(
		f.calls
			.filter((c) => /FROM (unidades|campanhas) ORDER BY/.test(c.sql))
			.every((c) => c.sql.endsWith("FOR UPDATE")),
	);
	const detail = await run(f, "detail", { id: 2 });
	assert.equal(detail.campaigns[0].NOME, "Clientes novos");
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
		run(f, "campaign-create", { fields: { ...campaign, UNIDADE: 1 } }),
		run(f, "campaign-create", {
			fields: { ...campaign, CODIGO: 12, UNIDADE: 1 },
		}),
	]);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(f.state.campaigns.length, 1);
});
test("name edit uses full CAS, preserves type/unit and blocks ambiguous activation", async () => {
	const f = fixture();
	await run(f, "create", { fields, campaigns: [campaign] });
	const { CODIGO, ...expected } = f.state.campaigns[0];
	await run(f, "campaign-patch", {
		id: CODIGO,
		changes: { NOME: "Nome comercial livre" },
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
		})),
	});
	const { CODIGO, ...expected } = f.state.campaigns[0];
	await run(f, "campaign-patch", {
		id: CODIGO,
		changes: { PAUSADA: "NAO" },
		expected,
	});
	const before = structuredClone(f.state.campaigns);
	await run(f, "patch", {
		id: 2,
		changes: { DESCRICAO: "Renomeada" },
		expected: fields,
	});
	assert.deepEqual(f.state.campaigns, before);
	await assert.rejects(
		run(f, "patch", {
			id: 2,
			changes: { DESCRICAO: "stale" },
			expected: fields,
		}),
		{ code: "TENANT_ORDERING_CHANGED" },
	);
	assert.equal(f.state.units[1].INATIVOS_RECENTES, 30);
});
