const test = require("node:test");
const assert = require("node:assert/strict");
const {
	transferCustomers,
	parseTransfer,
	transferTables,
} = require("../dist/tenant-database/administration-transfer");
const {
	readSnapshot,
	snapshotVersion,
} = require("../dist/tenant-database/administration-snapshot");
const { runTenantTransaction } = require("../dist/tenant-database/transaction");
const { tenantDatabaseConfig } = require("../dist/tenant-database/config");
const fields = {
	clientes: ["CODIGO", "RAZAO", "OPERADOR", "COD_CAMPANHA", "SETOR"],
	operadores: ["CODIGO", "NOME", "ATIVO", "SETOR"],
	campanhas_clientes: [
		"CODIGO",
		"CLIENTE",
		"CAMPANHA",
		"OPERADOR",
		"CONCLUIDO",
		"FIDELIZA",
		"DT_AGENDAMENTO",
		"DATA_HORA_LIG",
		"DATA_HORA_FIM",
	],
	fidelizacoes: [
		"CODIGO",
		"CLIENTE",
		"OPERADOR_CRIACAO",
		"CC_CODIGO",
		"QTDE_FIDELIZAR",
	],
	transferencia_clientes: [
		"CODIGO",
		"DATA_HORA",
		"OPERADOR",
		"OPERADOR_ORIGEM",
		"OPERADOR_DESTINO",
	],
	transferencia_clientes_itens: ["CODIGO", "CLIENTE"],
	crm_administration_transfers: [
		"operation_id",
		"request_hash",
		"actor_id",
		"transfer_id",
		"before_json",
		"after_json",
		"created_at",
	],
};
function fixture(options = {}) {
	const state = {
		clientes: [
			{
				CODIGO: 1,
				RAZAO: "Cliente á",
				OPERADOR: 10,
				COD_CAMPANHA: 3,
				SETOR: 2,
			},
			{
				CODIGO: 2,
				RAZAO: "Outro",
				OPERADOR: 10,
				COD_CAMPANHA: 3,
				SETOR: 2,
			},
		],
		operadores: [
			{ CODIGO: 10, NOME: "Origem", ATIVO: "SIM", SETOR: 2 },
			{ CODIGO: 20, NOME: "Destino", ATIVO: "SIM", SETOR: 2 },
			{ CODIGO: 99, NOME: "Supervisor", ATIVO: "SIM", SETOR: 2 },
		],
		campanhas_clientes: [
			{
				CODIGO: 7,
				CLIENTE: 1,
				CAMPANHA: 3,
				OPERADOR: 10,
				CONCLUIDO: "NAO",
				FIDELIZA: "S",
				DT_AGENDAMENTO: "2026-12-01 10:00:00",
				DATA_HORA_LIG: null,
				DATA_HORA_FIM: null,
			},
			{
				CODIGO: 8,
				CLIENTE: 1,
				CAMPANHA: 4,
				OPERADOR: 30,
				CONCLUIDO: "NAO",
				FIDELIZA: null,
				DT_AGENDAMENTO: "0000-00-00 00:00:00",
				DATA_HORA_LIG: null,
				DATA_HORA_FIM: null,
			},
			{
				CODIGO: 9,
				CLIENTE: 1,
				CAMPANHA: 3,
				OPERADOR: 10,
				CONCLUIDO: "SIM",
				FIDELIZA: "S",
				DT_AGENDAMENTO: null,
				DATA_HORA_LIG: "2026-01-01 10:00:00",
				DATA_HORA_FIM: "2026-01-01 10:10:00",
			},
		],
		fidelizacoes: [
			{
				CODIGO: 5,
				CLIENTE: 1,
				OPERADOR_CRIACAO: 10,
				CC_CODIGO: 3,
				QTDE_FIDELIZAR: 8,
			},
		],
		transferencia_clientes: [],
		transferencia_clientes_itens: [],
		crm_administration_transfers: [],
	};
	let baseline;
	const queries = [],
		controls = [];
	const execute = async (sql, params = []) => {
		queries.push({ sql, params });
		if (sql.startsWith("SELECT 1 FROM")) return [];
		if (sql.includes("information_schema.TABLES"))
			return transferTables.map((name) => ({
				name,
				engine:
					options.myisam && name === "clientes" ? "MyISAM" : "InnoDB",
			}));
		if (sql.includes("information_schema.TRIGGERS"))
			return options.triggers ? [{ TRIGGER_NAME: "legacy" }] : [];
		if (sql.includes("information_schema.STATISTICS"))
			return options.noPrimary
				? []
				: [
						{
							column_name: "operation_id",
							sequence: 1,
							prefix_length: null,
						},
					];
		if (sql.includes("information_schema.COLUMNS"))
			return Object.entries(fields).flatMap(([table, columns]) =>
				columns
					.filter(
						(column) =>
							!options.missingColumn ||
							column !== "QTDE_FIDELIZAR",
					)
					.map((column) => ({
						table_name: table,
						column_name: column,
						data_type: [
							"RAZAO",
							"NOME",
							"ATIVO",
							"CONCLUIDO",
							"FIDELIZA",
						].includes(column)
							? "varchar"
							: [
										"DT_AGENDAMENTO",
										"DATA_HORA_LIG",
										"DATA_HORA_FIM",
								  ].includes(column)
								? "datetime"
								: "int",
					})),
			);
		if (
			sql.startsWith("SELECT CODIGO FROM operadores") ||
			sql.startsWith("SELECT CODIGO,SETOR FROM operadores")
		)
			return state.operadores;
		if (sql.startsWith("SELECT request_hash,transfer_id"))
			return state.crm_administration_transfers.filter(
				(row) => row.operation_id === params[0],
			);
		if (sql.startsWith("SELECT CAST")) {
			const table = sql.match(/FROM `([^`]+)`/)[1];
			let rows = state[table].filter((row) =>
				params
					.map(String)
					.includes(
						String(
							row[
								table === "clientes" || table === "operadores"
									? "CODIGO"
									: "CLIENTE"
							],
						),
					),
			);
			if (table === "campanhas_clientes")
				rows = rows.filter((row) => row.CONCLUIDO === "NAO");
			return rows.map((row) =>
				Object.fromEntries(
					fields[table].map((field) => [field, row[field] ?? null]),
				),
			);
		}
		if (sql.startsWith("INSERT INTO transferencia_clientes (")) {
			state.transferencia_clientes.push({
				CODIGO: 41,
				OPERADOR: params[0],
				OPERADOR_ORIGEM: params[1],
				OPERADOR_DESTINO: params[2],
			});
			return { affectedRows: 1, insertId: 41 };
		}
		if (sql.startsWith("INSERT INTO transferencia_clientes_itens")) {
			for (let i = 0; i < params.length; i += 2)
				state.transferencia_clientes_itens.push({
					CODIGO: params[i],
					CLIENTE: params[i + 1],
				});
			return { affectedRows: params.length / 2 };
		}
		if (sql.startsWith("UPDATE `")) {
			const [, table, field] = sql.match(
				/UPDATE `([^`]+)` SET `([^`]+)`/,
			);
			const ids = params.slice(1, -1);
			let affectedRows = 0;
			for (const row of state[table])
				if (ids.includes(row.CODIGO) && row[field] === params.at(-1)) {
					row[field] = params[0];
					affectedRows++;
				}
			return { affectedRows: options.wrongCount ? 0 : affectedRows };
		}
		if (sql.startsWith("INSERT INTO crm_administration_transfers")) {
			if (options.auditFailure) throw new Error("synthetic failure");
			state.crm_administration_transfers.push(
				Object.fromEntries(
					[
						"operation_id",
						"request_hash",
						"actor_id",
						"transfer_id",
						"before_json",
						"after_json",
					].map((key, i) => [key, params[i]]),
				),
			);
			return { affectedRows: 1 };
		}
		throw new Error(`Unexpected SQL ${sql}`);
	};
	const connection = {
		execute,
		control: async (sql) => {
			controls.push(sql);
			if (sql === "START TRANSACTION") baseline = structuredClone(state);
			if (sql === "ROLLBACK")
				for (const key of Object.keys(state))
					state[key] = baseline[key];
		},
		release() {},
		destroy() {},
	};
	return {
		state,
		queries,
		controls,
		execute,
		async input(tenant = "tenant-a") {
			const snapshot = await readSnapshot(execute, tenant, [1], 10, 20);
			return parseTransfer({
				operation: "crm.administration.transfer",
				operationId: "a0000000-0000-4000-8000-000000000001",
				actorId: 99,
				source: 10,
				destination: 20,
				customerIds: [1],
				version: snapshotVersion(tenant, [1], 10, 20, snapshot),
			});
		},
		apply(input, tenant = "tenant-a") {
			return runTenantTransaction(
				connection,
				tenant,
				transferTables,
				tenantDatabaseConfig({}),
				(tx) => transferCustomers(tx, input),
				true,
				true,
			);
		},
	};
}
test("structured command rejects injected SQL, actor overrides, public destination and duplicate selection", () => {
	const input = {
		operation: "crm.administration.transfer",
		operationId: "a0000000-0000-4000-8000-000000000001",
		actorId: 99,
		source: 10,
		destination: 20,
		customerIds: [1],
		version: "a".repeat(64),
	};
	for (const patch of [
		{ sql: "DELETE FROM clientes" },
		{ destination: 0 },
		{ customerIds: [1, 1] },
		{ source: 20 },
		{ actorId: 0 },
		{ operationId: "bad" },
	])
		assert.throws(
			() => parseTransfer({ ...input, ...patch }),
			/TENANT_TRANSACTION_INVALID_REQUEST/,
		);
});
test("atomic transfer preserves completed schedules, counters, other operators and unselected customers; keeps import records", async () => {
	const f = fixture();
	const input = await f.input();
	const result = await f.apply(input);
	assert.deepEqual(result, {
		operationId: input.operationId,
		transferId: 41,
		status: "applied",
	});
	assert.equal(f.state.clientes[0].OPERADOR, 20);
	assert.equal(f.state.clientes[1].OPERADOR, 10);
	assert.deepEqual(
		f.state.campanhas_clientes.map((row) => row.OPERADOR),
		[20, 30, 10],
	);
	assert.equal(f.state.campanhas_clientes[0].FIDELIZA, "S");
	assert.equal(f.state.fidelizacoes[0].QTDE_FIDELIZAR, 8);
	assert.equal(f.state.fidelizacoes[0].OPERADOR_CRIACAO, 20);
	assert.equal(f.state.operadores[0].ATIVO, "SIM");
	assert.equal(f.state.transferencia_clientes_itens[0].CLIENTE, 1);
	assert.equal(f.state.crm_administration_transfers.length, 1);
	assert.equal(
		JSON.parse(f.state.crm_administration_transfers[0].before_json)
			.customers[0].OPERADOR,
		"10",
	);
	assert.ok(
		f.controls.includes("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"),
	);
	assert.ok(
		f.controls.indexOf("SET SESSION time_zone = @@GLOBAL.time_zone") <
			f.controls.indexOf("SET @inpulse_crm_transfer_at = NOW(), @inpulse_crm_utc_at = UTC_TIMESTAMP()"),
	);
	assert.ok(
		f.controls.indexOf("SET @inpulse_crm_transfer_at = NOW(), @inpulse_crm_utc_at = UTC_TIMESTAMP()") <
			f.controls.indexOf("SET SESSION time_zone = '+00:00'"),
	);
	assert.ok(
		f.queries.some((q) =>
			q.sql.includes("VALUES (@inpulse_crm_transfer_at,?,?,?)"),
		),
	);
	assert.ok(
		f.queries.some((q) =>
			q.sql.includes("ORDER BY CODIGO LIMIT 501 FOR UPDATE"),
		),
	);
	await f.apply(input);
	assert.equal(f.state.transferencia_clientes.length, 1);
	await f.apply(
		parseTransfer(Object.fromEntries(Object.entries(input).reverse())),
	);
	assert.equal(f.state.transferencia_clientes.length, 1);
	await assert.rejects(
		f.apply({ ...input, actorId: 100 }),
		/TENANT_ADMINISTRATION_OPERATION_CONFLICT/,
	);
});
test("stale preview and cross-tenant hash cannot mutate", async () => {
	for (const change of ["operator", "tenant", "agenda", "loyalty"]) {
		const f = fixture(),
			input = await f.input();
		if (change === "operator") f.state.clientes[0].OPERADOR = 30;
		if (change === "agenda")
			f.state.campanhas_clientes[0].DT_AGENDAMENTO =
				"2027-01-01 10:00:00";
		if (change === "loyalty") f.state.fidelizacoes[0].QTDE_FIDELIZAR = 9;
		await assert.rejects(
			f.apply(input, change === "tenant" ? "tenant-b" : "tenant-a"),
			/TENANT_ADMINISTRATION_SELECTION_CHANGED/,
		);
		assert.equal(f.state.transferencia_clientes.length, 0);
	}
});
test("active attendance on any pending campaign, inactive destination and unsupported metadata block before writes", async () => {
	for (const kind of [
		"call",
		"inactive",
		"triggers",
		"noPrimary",
		"myisam",
		"missingColumn",
	]) {
		const f = fixture({ [kind]: true });
		let input;
		if (kind === "missingColumn") {
			await assert.rejects(f.input(), /SCHEMA_UNSUPPORTED/);
			continue;
		}
		if (kind === "call")
			f.state.campanhas_clientes[1].DATA_HORA_LIG = "2026-11-03 10:00:00";
		if (kind === "inactive") f.state.operadores[1].ATIVO = "NAO";
		input = await f.input();
		await assert.rejects(f.apply(input));
		assert.equal(f.state.transferencia_clientes.length, 0);
	}
});
test("affected-row conflict and audit failure roll back every prior write", async () => {
	for (const option of ["wrongCount", "auditFailure"]) {
		const f = fixture({ [option]: true }),
			input = await f.input();
		await assert.rejects(f.apply(input));
		assert.equal(f.state.clientes[0].OPERADOR, 10);
		assert.equal(f.state.campanhas_clientes[0].OPERADOR, 10);
		assert.equal(f.state.fidelizacoes[0].OPERADOR_CRIACAO, 10);
		assert.equal(f.state.transferencia_clientes.length, 0);
		assert.equal(f.state.transferencia_clientes_itens.length, 0);
		assert.ok(f.controls.includes("ROLLBACK"));
	}
});
test("Nunes enforces the current actor sector under row locks, allowing sector 3 global scope", async () => {
	const own = fixture();
	await own.apply(await own.input("nunes"), "nunes");
	assert.equal(own.state.clientes[0].OPERADOR, 20);
	const outside = fixture();
	outside.state.clientes[0].SETOR = 4;
	outside.state.operadores[1].SETOR = 4;
	await assert.rejects(
		outside.apply(await outside.input("nunes"), "nunes"),
		/TENANT_ADMINISTRATION_FORBIDDEN/,
	);
	assert.equal(outside.state.transferencia_clientes.length, 0);
	const global = fixture();
	global.state.clientes[0].SETOR = 4;
	global.state.operadores[1].SETOR = 4;
	global.state.operadores[2].SETOR = 3;
	await global.apply(await global.input("nunes"), "nunes");
	assert.equal(global.state.clientes[0].OPERADOR, 20);
});
test("new pending links invalidate a preview and selections with excessive historical links fail closed", async () => {
	const added = fixture(),
		input = await added.input();
	added.state.campanhas_clientes.push({
		...added.state.campanhas_clientes[0],
		CODIGO: 11,
	});
	await assert.rejects(
		added.apply(input),
		/TENANT_ADMINISTRATION_SELECTION_CHANGED/,
	);
	assert.equal(added.state.transferencia_clientes.length, 0);
	const large = fixture();
	large.state.fidelizacoes = Array.from({ length: 501 }, (_, index) => ({
		...large.state.fidelizacoes[0],
		CODIGO: index + 1,
	}));
	await assert.rejects(large.input(), /SELECTION_TOO_LARGE/);
});
