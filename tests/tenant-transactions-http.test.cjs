const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac, randomUUID } = require("node:crypto");
const { createServer } = require("node:http");
const { once } = require("node:events");
const express = require("express");
const {
	createTenantTransactionsRouter,
} = require("../dist/controllers/tenant-transactions.controller");
const { TenantDatabaseError } = require("../dist/tenant-database/error");

const key = "local-test-only-transaction-key-0123456789";
const fixedNow = 1_792_400_000_000;
const batch = () => ({
	operation: "telephony.schedule.edit",
	tables: [
		"campanhas_clientes",
		"telephony_schedule_edits",
		"clientes",
		"operadores",
	],
	statements: [
		{
			sql: "UPDATE campanhas_clientes SET OPERADOR = ? WHERE CODIGO = ?",
			params: [20, 1],
			expectAffectedRows: 1,
		},
		{
			sql: "INSERT INTO telephony_schedule_edits (operation_id) VALUES (?)",
			params: ["op"],
			expectAffectedRows: 1,
		},
	],
});
async function fixture(t, options = {}) {
	const queries = [],
		transactions = [];
	const database = {
		async transaction(instance, operation, tables, callback) {
			transactions.push({ instance, operation, tables });
			if (options.error) throw options.error;
			return callback({
				async execute(sql, params) {
					queries.push({ sql, params });
					if (
						sql.includes("information_schema.COLUMNS") &&
						sql.includes("TABLE_NAME='crm_import_receipts'")
					)
						return options.badImportSchema ? [] : receiptColumns();
					if (
						sql.includes("information_schema.STATISTICS") &&
						sql.includes("TABLE_NAME='crm_import_receipts'")
					)
						return [
							{ COLUMN_NAME: "operation_key", SUB_PART: null },
						];
					if (
						sql ===
						"SELECT CODIGO,ATIVO,NIVEL FROM operadores WHERE CODIGO=? FOR UPDATE"
					)
						return [
							{
								CODIGO: params[0],
								ATIVO: "SIM",
								NIVEL: options.importActorDenied
									? "ATIVO"
									: "ADMIN",
							},
						];
					if (
						sql.startsWith(
							"SELECT request_hash,actor_id,customer_id FROM crm_import_receipts",
						)
					)
						return options.importReceiptRows ?? [];
					if (
						sql.startsWith(
							"SELECT CODIGO FROM clientes WHERE CODIGO<>?",
						)
					)
						return options.importDuplicate ? [{ CODIGO: 44 }] : [];
					if (
						options.importReceiptFailure &&
						sql.startsWith("INSERT INTO crm_import_receipts")
					)
						throw new TenantDatabaseError(
							"TENANT_TRANSACTION_QUERY_FAILED",
						);
					if (
						sql ===
						"SELECT PESQSAT_CODIGO,PESQ_DESCRICAO FROM pesquisa_satisfacao ORDER BY PESQSAT_CODIGO LIMIT 101 FOR UPDATE"
					)
						return (
							options.questions ?? [
								{
									PESQSAT_CODIGO: 1,
									PESQ_DESCRICAO: "Atendimento?",
								},
							]
						);
					if (
						sql ===
						"SELECT PESQSAT_CODIGO FROM pesquisa_satisfacao_avaliacao WHERE CAMPCLI_CODIGO=? LIMIT 1 FOR UPDATE"
					)
						return options.existingSurvey
							? [{ PESQSAT_CODIGO: 1 }]
							: [];
					if (
						sql ===
						"SELECT CAMPCLI_CODIGO FROM pesquisa_satisfacao_avaliacao WHERE PESQSAT_CODIGO=? LIMIT 1 FOR UPDATE"
					)
						return options.used ? [{ CAMPCLI_CODIGO: 41 }] : [];
					if (
						sql.startsWith(
							"INSERT INTO pesquisa_satisfacao_avaliacao",
						)
					) {
						if (options.failAnswers)
							throw new TenantDatabaseError(
								"TENANT_TRANSACTION_QUERY_FAILED",
							);
						return { affectedRows: options.answerCount ?? 1 };
					}

					if (sql.includes("information_schema.TRIGGERS"))
						return options.triggers ?? [];
					if (sql.includes("information_schema.COLUMNS"))
						return options.phoneColumns ?? [];
					if (
						sql.includes("information_schema.KEY_COLUMN_USAGE") &&
						sql.includes(
							"REFERENCED_TABLE_NAME='fones_campanha_cli'",
						)
					)
						return [];
					if (sql.includes("information_schema.STATISTICS"))
						return [
							{ INDEX_NAME: "u", COLUMN_NAME: "CLIENTE" },
							{ INDEX_NAME: "u", COLUMN_NAME: "FONE" },
						];
					if (/^SELECT `AREA/.test(sql))
						return [
							options.customerPhones ?? {
								AREA1: 11,
								FONE1: "33333333",
							},
						];
					if (
						options.failSync &&
						/^INSERT INTO fones_campanha_cli/.test(sql)
					)
						throw new TenantDatabaseError(
							"TENANT_TRANSACTION_QUERY_FAILED",
						);
					if (/^INSERT INTO `?clientes`?\s/.test(sql))
						return { affectedRows: 1, insertId: 41 };
					if (/^SELECT CODIGO FROM parametros/.test(sql))
						return options.missingPolicy ? [] : [{ CODIGO: 1 }];
					if (
						/^SELECT CODIGO FROM clientes WHERE CODIGO=\? FOR UPDATE/.test(
							sql,
						)
					)
						return [{ CODIGO: params[0] }];
					if (
						sql.startsWith(
							"SELECT operation_id FROM crm_proposal_events",
						)
					)
						return options.usedProposalOperation
							? [{ operation_id: params[0] }]
							: [];
					if (sql.startsWith("SELECT CODIGO FROM propostas"))
						return [{ CODIGO: params[0] }];
					if (
						sql.startsWith("SELECT PROPOSTA FROM propostas_compras")
					)
						return [];
					if (sql.includes("information_schema.KEY_COLUMN_USAGE"))
						return options.proposalReferences ?? [];
					if (
						sql ===
						"SELECT CODIGO FROM campanhas WHERE CODIGO=? FOR UPDATE"
					)
						return options.missingCampaign
							? []
							: [{ CODIGO: params[0] }];
					if (
						sql ===
						"SELECT CODIGO FROM campanhas_clientes WHERE CODIGO=? FOR UPDATE"
					)
						return options.missingSchedule
							? []
							: [{ CODIGO: params[0] }];
					if (
						/^INSERT INTO campanhas_clientes\b/.test(sql) &&
						options.generationCount !== undefined
					)
						return { affectedRows: options.generationCount };
					return {
						affectedRows: options.affectedRows ?? 1,
						...(/^INSERT INTO historico_cli/.test(sql) &&
						!options.missingHistoryId
							? { insertId: 71 }
							: {}),
					};
				},
			});
		},
	};
	const app = express();
	app.use(express.json());
	app.use(
		createTenantTransactionsRouter(
			() => database,
			() => (options.secret === undefined ? key : options.secret),
			() => fixedNow,
		),
	);
	const server = createServer(app);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(
		() =>
			new Promise((resolve) => {
				server.close(resolve);
				server.closeAllConnections();
			}),
	);
	const url = `http://127.0.0.1:${server.address().port}`;
	const sign = (
		body,
		path = "/api/instances/alpha/transactions",
		overrides = {},
	) => {
		const timestamp = String(overrides.timestamp ?? fixedNow),
			nonce = overrides.nonce ?? randomUUID();
		const signature = createHmac("sha256", key)
			.update(`${timestamp}\n${nonce}\n${path}\n${JSON.stringify(body)}`)
			.digest("hex");
		return {
			"content-type": "application/json",
			"x-tenant-timestamp": timestamp,
			"x-tenant-nonce": nonce,
			"x-tenant-signature": signature,
		};
	};
	const send = async (body, options = {}) => {
		const path = options.path ?? "/api/instances/alpha/transactions";
		const response = await fetch(url + path, {
			method: "POST",
			headers: options.headers ?? sign(body, path),
			body: JSON.stringify(body),
		});
		return { status: response.status, body: await response.json() };
	};
	return { transactions, queries, send, sign };
}

test("signed command binds tenant, payload and operation; executes sequentially and returns only acknowledgement", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await f.send(batch()), {
		status: 200,
		body: { data: [{ affectedRows: 1 }, { affectedRows: 1 }] },
	});
	assert.equal(f.transactions.length, 1);
	assert.equal(f.transactions[0].instance, "alpha");
	assert.match(f.queries[0].sql, /information_schema.TRIGGERS/);
	assert.match(f.queries[1].sql, /^UPDATE/);
	assert.match(f.queries[2].sql, /^INSERT/);
});

test("administration accepts only the structured signed command and owns its table list", async (t) => {
	const f = await fixture(t, {
		error: new TenantDatabaseError("TENANT_TRANSACTION_REQUIRES_INNODB"),
	});
	const command = {
		operation: "crm.administration.transfer",
		operationId: "a0000000-0000-4000-8000-000000000001",
		actorId: 99,
		source: 10,
		destination: 20,
		customerIds: [1],
		version: "a".repeat(64),
	};
	for (const patch of [
		{ statements: batch().statements },
		{ tables: ["clientes"] },
		{ sql: "DELETE FROM clientes" },
		{ destination: 0 },
	])
		assert.equal((await f.send({ ...command, ...patch })).status, 400);
	assert.equal(
		(
			await f.send(command, {
				headers: { "content-type": "application/json" },
			})
		).status,
		401,
	);
	const result = await f.send(command);
	assert.equal(result.body.code, "TENANT_TRANSACTION_REQUIRES_INNODB");
	assert.equal(f.transactions.length, 1);
	assert.equal(f.transactions[0].instance, "alpha");
	assert.equal(f.transactions[0].operation, "crm.administration.transfer");
	assert.deepEqual(f.transactions[0].tables, [
		"clientes",
		"operadores",
		"campanhas_clientes",
		"fidelizacoes",
		"transferencia_clientes",
		"transferencia_clientes_itens",
		"crm_administration_transfers",
	]);
});

test("customer write locks policy then customer, keeps history in one signed batch and rejects undeclared history/other resources", async (t) => {
	const f = await fixture(t);
	const body = {
		operation: "crm.customer.write",
		customerId: 4,
		tables: ["clientes", "parametros", "motivo_desativacao_cliente"],
		statements: [
			{
				sql: "UPDATE clientes SET ATIVO=? WHERE CODIGO=?",
				params: ["NAO", 4],
				expectAffectedRows: 1,
			},
			{
				sql: "INSERT INTO motivo_desativacao_cliente (CLIENTE) SELECT ?",
				params: [4],
				expectAffectedRows: 1,
			},
		],
	};
	assert.equal((await f.send(body)).status, 200);
	assert.match(
		f.queries[1].sql,
		/^SELECT CODIGO FROM parametros.*FOR UPDATE$/,
	);
	assert.match(f.queries[2].sql, /^SELECT CODIGO FROM clientes.*FOR UPDATE$/);
	for (const mutate of [
		(value) => value.tables.push("wallets"),
		(value) => (value.customerId = -1),
		(value) => (value.statements[0].sql = "DELETE FROM clientes"),
		(value) => (value.tables = ["clientes", "parametros"]),
		(value) => (value.statements[0].expectAffectedRows = 0),
	]) {
		const invalid = structuredClone(body);
		mutate(invalid);
		assert.equal((await f.send(invalid)).status, 400);
	}
	const unavailable = await fixture(t, { missingPolicy: true });
	assert.equal(
		(await unavailable.send(body)).body.code,
		"TENANT_CUSTOMER_POLICY_UNAVAILABLE",
	);
	assert.equal(unavailable.queries.length, 2);
});
function phoneColumns() {
	return [
		{ TABLE_NAME: "clientes", COLUMN_NAME: "AREA1" },
		{ TABLE_NAME: "clientes", COLUMN_NAME: "FONE1" },
		...["CODIGO", "CLIENTE", "FONE"].map((COLUMN_NAME) => ({
			TABLE_NAME: "fones_campanha_cli",
			COLUMN_NAME,
			DATA_TYPE: COLUMN_NAME === "FONE" ? "varchar" : "int",
			EXTRA: COLUMN_NAME === "CODIGO" ? "auto_increment" : "",
			COLUMN_KEY: COLUMN_NAME === "CODIGO" ? "PRI" : "",
			IS_NULLABLE: "YES",
			COLUMN_DEFAULT: null,
			CHARACTER_MAXIMUM_LENGTH: 12,
		})),
	];
}
function phoneBatch(create = false) {
	return {
		operation: "crm.customer.write",
		customerId: create ? 0 : 42,
		syncPhones: true,
		tables: ["clientes", "parametros", "fones_campanha_cli"],
		statements: [
			{
				sql: create
					? "INSERT INTO clientes (AREA1,FONE1) SELECT ?,?"
					: "UPDATE clientes SET FONE1=? WHERE CODIGO=?",
				params: create ? [11, "33333333"] : ["33333333", 42],
				expectAffectedRows: 1,
			},
		],
	};
}
test("phone writes require the declared fixed sync, include trigger protection and keep the acknowledgement contract", async (t) => {
	const f = await fixture(t, { phoneColumns: phoneColumns() });
	assert.deepEqual(await f.send(phoneBatch()), {
		status: 200,
		body: { data: [{ affectedRows: 1 }] },
	});
	assert.deepEqual(f.queries[0].params, ["clientes", "fones_campanha_cli"]);
	assert.deepEqual(
		f.queries.find((q) => q.sql.startsWith("DELETE FROM fones")).params,
		[42, "1133333333"],
	);
	for (const mutate of [
		(b) => delete b.syncPhones,
		(b) => (b.syncPhones = false),
		(b) => b.tables.pop(),
		(b) =>
			b.statements.push({
				sql: "DELETE FROM fones_campanha_cli WHERE CLIENTE=?",
				params: [42],
				expectAffectedRows: 1,
			}),
	]) {
		const body = phoneBatch();
		mutate(body);
		assert.equal((await f.send(body)).status, 400);
	}
	const missing = phoneBatch();
	delete missing.syncPhones;
	missing.tables.pop();
	assert.equal((await f.send(missing)).status, 400);
});
test("new customer sync uses the acknowledged insertId, not connection LAST_INSERT_ID after a history insert", async (t) => {
	const f = await fixture(t, { phoneColumns: phoneColumns() });
	assert.deepEqual(await f.send(phoneBatch(true)), {
		status: 200,
		body: { data: [{ affectedRows: 1, insertId: 41 }] },
	});
	assert.deepEqual(
		f.queries.find((q) => q.sql.startsWith("DELETE FROM fones")).params,
		[41, "1133333333"],
	);
});
test("phone schema or sync failure rejects the transaction and trigger failure prevents the customer write", async (t) => {
	for (const options of [
		{},
		{ phoneColumns: phoneColumns(), failSync: true },
	]) {
		const f = await fixture(t, options),
			result = await f.send(phoneBatch());
		assert.equal(result.status, 503);
		assert.equal(result.body.outcome, "NOT_COMMITTED");
		assert.equal(f.transactions.length, 1);
	}
	const f = await fixture(t, {
		triggers: [{ TRIGGER_NAME: "fones_trigger" }],
	});
	assert.equal(
		(await f.send(phoneBatch())).body.code,
		"TENANT_TRANSACTION_UNREVIEWED_TRIGGERS",
	);
	assert.equal(f.queries.length, 1);
});
function generationBatch(count = 2) {
	return {
		operation: "crm.campaign.generate",
		campaignId: 12,
		tables: [
			"campanhas",
			"campanhas_clientes",
			"clientes",
			"operadores",
			"excecoes",
			"excecoes_cidade",
			"excecoes_estado",
			"excecoes_segmentos",
		],
		statements: [
			{
				sql: "UPDATE campanhas SET GERADO_LISTA='SIM' WHERE CODIGO=? AND GERADO_LISTA='NAO'",
				params: [12],
				expectAffectedRows: 1,
			},
			{
				sql: "INSERT INTO campanhas_clientes (CLIENTE,CAMPANHA) SELECT CODIGO,? FROM clientes LIMIT 2001",
				params: [12],
				expectAffectedRows: count,
			},
		],
	};
}
test("campaign generation uses the signed bounded operation and guards both mutated tables", async (t) => {
	const f = await fixture(t, { generationCount: 2 });
	assert.deepEqual(await f.send(generationBatch()), {
		status: 200,
		body: { data: [{ affectedRows: 1 }, { affectedRows: 2 }] },
	});
	assert.equal(f.transactions[0].operation, "crm.campaign.generate");
	assert.deepEqual(f.queries[0].params, ["campanhas", "campanhas_clientes"]);
	assert.equal(
		f.queries[1].sql,
		"SELECT CODIGO FROM campanhas WHERE CODIGO=? FOR UPDATE",
	);
	assert.deepEqual(f.queries[1].params, [12]);
	assert.match(f.queries[2].sql, /^UPDATE/);
});
test("campaign generation rolls back a changed audience count and rejects unbounded SQL/counts", async (t) => {
	const f = await fixture(t, { generationCount: 3 });
	assert.deepEqual(await f.send(generationBatch(2)), {
		status: 409,
		body: {
			code: "TENANT_TRANSACTION_AFFECTED_ROWS",
			outcome: "NOT_COMMITTED",
		},
	});
	for (const mutate of [
		(b) => delete b.campaignId,
		(b) => (b.campaignId = 0),
		(b) => (b.campaignId = 2147483648),
		(b) => (b.statements[1].expectAffectedRows = 2001),
		(b) => (b.statements[1].expectAffectedRows = -1),
		(b) => (b.statements[0].expectAffectedRows = 2),
		(b) => (b.statements[1].sql = "DELETE FROM campanhas_clientes"),
		(b) => b.tables.pop(),
	]) {
		const body = generationBatch();
		mutate(body);
		assert.equal((await f.send(body)).status, 400);
	}
});
test("generation locks a known campaign before any audience write", async (t) => {
	const f = await fixture(t, { missingCampaign: true });
	assert.equal((await f.send(generationBatch())).status, 409);
	assert.equal(f.queries.length, 2);
});
function finishBatch() {
	return {
		operation: "telephony.schedule.finish",
		scheduleId: 41,
		tables: [
			"campanhas_clientes",
			"historico_cli",
			"telephony_schedule_finishes",
			"resultados",
			"operadores",
		],
		statements: [
			{
				sql: "UPDATE campanhas_clientes SET RESULTADO=? WHERE CODIGO=? AND OPERADOR=?",
				params: [9, 41, 7],
				expectAffectedRows: 1,
			},
			{
				sql: "INSERT INTO historico_cli (CLIENTE,CC_CODIGO) VALUES (?,?)",
				params: [1, 41],
				expectAffectedRows: 1,
			},
			{
				sql: "INSERT INTO telephony_schedule_finishes (operation_id) VALUES (?)",
				params: ["fixture-op"],
				expectAffectedRows: 1,
			},
		],
	};
}
test("finalization locks one schedule and atomically requires schedule, history and receipt acknowledgements", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await f.send(finishBatch()), {
		status: 200,
		body: {
			data: [
				{ affectedRows: 1 },
				{ affectedRows: 1 },
				{ affectedRows: 1 },
			],
		},
	});
	assert.equal(f.transactions[0].operation, "telephony.schedule.finish");
	assert.deepEqual(f.queries[0].params, [
		"campanhas_clientes",
		"historico_cli",
		"telephony_schedule_finishes",
	]);
	assert.equal(
		f.queries[1].sql,
		"SELECT CODIGO FROM campanhas_clientes WHERE CODIGO=? FOR UPDATE",
	);
	assert.deepEqual(f.queries[1].params, [41]);
});
test("finalization rejects missing locks, missing required tables, mutated operations and unsigned context", async (t) => {
	const f = await fixture(t, { missingSchedule: true });
	assert.equal((await f.send(finishBatch())).status, 409);
	assert.equal(f.queries.length, 2);
	const g = await fixture(t);
	for (const mutate of [
		(b) => delete b.scheduleId,
		(b) => (b.scheduleId = 0),
		(b) => (b.scheduleId = 2147483648),
		(b) => b.tables.pop(),
		(b) => b.statements.pop(),
		(b) =>
			(b.statements[1].sql =
				"INSERT INTO operadores (CODIGO) VALUES (?)"),
		(b) =>
			(b.statements[2].sql =
				"INSERT INTO historico_cli (CLIENTE) VALUES (?)"),
		(b) => (b.statements[1].expectAffectedRows = 0),
		(b) => (b.campaignId = 12),
	]) {
		const body = finishBatch();
		mutate(body);
		assert.equal((await g.send(body)).status, 400);
	}
	assert.equal(g.transactions.length, 0);
});
test("no signing secret fails closed without contacting tenant", async (t) => {
	const f = await fixture(t, { secret: "" });
	assert.equal((await f.send(batch())).status, 503);
	assert.equal(f.transactions.length, 0);
});
test("unsigned, tampered payload, changed tenant and stale signature never reach tenant", async (t) => {
	const f = await fixture(t),
		body = batch(),
		headers = f.sign(body);
	assert.equal(
		(
			await f.send(body, {
				headers: { "content-type": "application/json" },
			})
		).status,
		401,
	);
	const changed = batch();
	changed.statements[0].params[0] = 999;
	assert.equal((await f.send(changed, { headers })).status, 401);
	assert.equal(
		(
			await f.send(body, {
				path: "/api/instances/beta/transactions",
				headers,
			})
		).status,
		401,
	);
	assert.equal(
		(
			await f.send(body, {
				headers: f.sign(body, undefined, {
					timestamp: fixedNow - 60001,
				}),
			})
		).status,
		401,
	);
	assert.equal(f.transactions.length, 0);
});
test("identical transport nonce is never executed twice and does not claim rollback of first attempt", async (t) => {
	const f = await fixture(t),
		body = batch(),
		headers = f.sign(body);
	assert.equal((await f.send(body, { headers })).status, 200);
	const replay = await f.send(body, { headers });
	assert.equal(replay.status, 409);
	assert.equal(replay.body.outcome, "UNKNOWN");
	assert.equal(f.transactions.length, 1);
});
test("only bounded schedule-edit statements, parameters, known tables and expected row counts are accepted", async (t) => {
	const f = await fixture(t);
	for (const mutate of [
		(b) => (b.operation = "anything"),
		(b) => b.tables.push("users"),
		(b) => (b.tables = ["campanhas_clientes"]),
		(b) => b.statements.push(b.statements[0]),
		(b) => delete b.statements[0].expectAffectedRows,
		(b) => (b.statements[0].sql += "; DELETE FROM clientes"),
		(b) => (b.statements[0].sql = "DELETE FROM campanhas_clientes"),
		(b) => (b.statements[0].params = [{}]),
		(b) =>
			(b.statements[0].sql +=
				" AND NOT EXISTS (SELECT 1 FROM campanhas_clientes_validade)"),
		(b) => (b.host = "attacker"),
	]) {
		const body = batch();
		mutate(body);
		assert.equal((await f.send(body)).status, 400);
	}
	assert.equal(f.transactions.length, 0);
});
test("CAS zero rows aborts before audit insert with a specific rollback outcome", async (t) => {
	const f = await fixture(t, { affectedRows: 0 });
	const result = await f.send(batch());
	assert.deepEqual(result, {
		status: 409,
		body: {
			code: "TENANT_TRANSACTION_AFFECTED_ROWS",
			outcome: "NOT_COMMITTED",
		},
	});
	assert.equal(f.queries.length, 2);
});
test("unknown triggers block before writing under transaction metadata locks", async (t) => {
	const f = await fixture(t, { triggers: [{ TRIGGER_NAME: "legacy" }] });
	const result = await f.send(batch());
	assert.equal(result.status, 503);
	assert.equal(result.body.code, "TENANT_TRANSACTION_UNREVIEWED_TRIGGERS");
	assert.equal(f.queries.length, 1);
});
test("commit uncertainty and untyped failures are sanitized without request data or automatic retry", async (t) => {
	for (const error of [
		new TenantDatabaseError("TENANT_COMMIT_UNKNOWN", "UNKNOWN"),
		new Error("password SQL private record"),
	]) {
		const f = await fixture(t, { error });
		const result = await f.send(batch());
		assert.equal(result.status, 503);
		assert.equal(result.body.outcome, "UNKNOWN");
		assert.doesNotMatch(JSON.stringify(result), /password|private|SQL/);
		assert.equal(f.transactions.length, 1);
	}
});

const proposalSql = require("../dist/crm-proposals/sql");
function proposalChange() {
	return {
		operation: "crm.proposal.change",
		scheduleId: 41,
		tables: proposalSql.proposalTables,
		statements: [
			{
				sql: proposalSql.changeValueSql,
				params: ["120.75", 11, 41, "100.25", "ATIVA", 7, 0],
				expectAffectedRows: 1,
			},
			{
				sql: proposalSql.eventSql,
				params: [
					"177e179c-08b9-44e4-adb9-7f34956f342f",
					"a".repeat(64),
					11,
					41,
					7,
					"UPDATE",
					"100.25",
					"120.75",
					"ATIVA",
					"ATIVA",
					"Revisão",
					1,
					3,
				],
				expectAffectedRows: 1,
			},
		],
	};
}
test("proposal mutation uses exact SQL, serializes operation, row and purchase links before CAS and audit", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.send(proposalChange())).status, 200);
	assert.match(f.queries[0].sql, /information_schema.TRIGGERS/);
	assert.equal(
		f.queries[1].sql,
		"SELECT operation_id FROM crm_proposal_events WHERE operation_id=? FOR UPDATE",
	);
	assert.equal(
		f.queries[2].sql,
		"SELECT CODIGO FROM propostas WHERE CODIGO=? FOR UPDATE",
	);
	assert.equal(
		f.queries[3].sql,
		"SELECT PROPOSTA FROM propostas_compras WHERE PROPOSTA=? FOR UPDATE",
	);
	assert.equal(f.queries[4].sql, proposalSql.changeValueSql);
	assert.equal(f.queries[5].sql, proposalSql.eventSql);
});
test("proposal commands reject arbitrary SQL, cross-wired audit, missing capability and reused operations", async (t) => {
	const f = await fixture(t);
	for (const mutate of [
		(b) => (b.statements[0].sql = "UPDATE propostas SET VALOR=0"),
		(b) => (b.statements[1].params[2] = 99),
		(b) => (b.tables = b.tables.filter((t) => t !== "crm_proposal_events")),
		(b) => (b.statements[0].sql += "; DELETE FROM clientes"),
		(b) => b.statements[0].params.push("extra"),
	]) {
		const b = proposalChange();
		mutate(b);
		assert.equal((await f.send(b)).status, 400);
	}
	assert.equal(f.transactions.length, 0);
	const used = await fixture(t, { usedProposalOperation: true });
	assert.equal((await used.send(proposalChange())).status, 409);
	assert.equal(used.queries.length, 2);
	const stale = await fixture(t, { affectedRows: 0 });
	assert.equal((await stale.send(proposalChange())).status, 409);
	assert.ok(!stale.queries.some((q) => q.sql === proposalSql.eventSql));
});
test("proposal creation extends finalization without a general SQL statement escape", async (t) => {
	const f = await fixture(t);
	const b = {
		operation: "telephony.schedule.finish",
		scheduleId: 41,
		tables: [
			"campanhas_clientes",
			"historico_cli",
			"telephony_schedule_finishes",
			"resultados",
			"operadores",
			"propostas",
			"propostas_compras",
			"crm_proposal_events",
		],
		statements: [
			{
				sql: "UPDATE campanhas_clientes SET RESULTADO=? WHERE CODIGO=?",
				params: [9, 41],
				expectAffectedRows: 1,
			},
			{
				sql: "INSERT INTO historico_cli (CC_CODIGO) VALUES (?)",
				params: [41],
				expectAffectedRows: 1,
			},
			{
				sql: "INSERT INTO telephony_schedule_finishes (schedule_id) VALUES (?)",
				params: [41],
				expectAffectedRows: 1,
			},
			{
				sql: proposalSql.createSql,
				params: [41, "100.25", 41],
				expectAffectedRows: 1,
			},
			{
				sql: proposalSql.createEventSql,
				params: ["operation", "hash", 7, 41],
				expectAffectedRows: 1,
			},
		],
	};
	assert.equal((await f.send(b)).status, 200);
	b.statements[3].sql = "DELETE FROM propostas";
	assert.equal((await f.send(b)).status, 400);
});
test("proposal deletion refuses unreviewed foreign keys before any destructive statement", async (t) => {
	const f = await fixture(t, {
		proposalReferences: [
			{
				local_schema: 1,
				TABLE_NAME: "other_history",
				COLUMN_NAME: "proposal",
				REFERENCED_COLUMN_NAME: "CODIGO",
			},
		],
	});
	const b = proposalChange();
	b.statements[0] = {
		sql: proposalSql.deleteSql,
		params: [11, 41, "100.25", "ATIVA", 7, 0],
		expectAffectedRows: 1,
	};
	b.statements[1].params[5] = "DELETE";
	b.statements[1].params[7] = null;
	b.statements[1].params[9] = null;
	const result = await f.send(b);
	assert.equal(result.status, 503);
	assert.equal(result.body.code, "TENANT_PROPOSAL_UNREVIEWED_REFERENCES");
	assert.ok(!f.queries.some((q) => q.sql === proposalSql.deleteSql));
});

function questionBatch() {
	return {
		operation: "crm.satisfaction.question.write",
		questionId: 1,
		tables: ["pesquisa_satisfacao", "pesquisa_satisfacao_avaliacao"],
		statements: [
			{
				sql: "UPDATE pesquisa_satisfacao SET PESQ_DESCRICAO=? WHERE PESQSAT_CODIGO=?",
				params: ["Nova", 1],
				expectAffectedRows: 1,
			},
		],
	};
}
function surveyBatch() {
	const body = finishBatch();
	body.surveyQuestions = [{ id: 1, description: "Atendimento?" }];
	body.statements[2] = {
		sql: "INSERT INTO telephony_schedule_finishes (operation_id,request_hash,schedule_id,actor_id,created_at) VALUES (?,?,?,?,UTC_TIMESTAMP())",
		params: ["fixture-op", "a".repeat(64), 41, 7],
		expectAffectedRows: 1,
	};
	body.tables.push(
		"pesquisa_satisfacao",
		"pesquisa_satisfacao_avaliacao",
		"telephony_satisfaction_submissions",
	);
	body.statements.push(
		{
			sql: "INSERT INTO telephony_satisfaction_submissions (operation_id,schedule_id,actor_id,history_id,survey_json,created_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP())",
			params: [
				"fixture-op",
				41,
				7,
				null,
				JSON.stringify({
					questions: body.surveyQuestions,
					answers: [{ questionId: 1, rating: 5 }],
				}),
			],
			expectAffectedRows: 1,
		},
		{
			sql: "INSERT INTO pesquisa_satisfacao_avaliacao (CAMPCLI_CODIGO,PESQSAT_CODIGO,PESQSAT_AVALIACAO) VALUES (?,?,?)",
			params: [41, 1, "5"],
			expectAffectedRows: 1,
		},
	);
	return body;
}
test("question mutation locks the complete catalog and evaluation key before writing, rejects used questions", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.send(questionBatch())).status, 200);
	assert.match(
		f.queries[1].sql,
		/ORDER BY PESQSAT_CODIGO LIMIT 101 FOR UPDATE/,
	);
	assert.match(f.queries[2].sql, /PESQSAT_CODIGO=\? LIMIT 1 FOR UPDATE/);
	assert.match(f.queries[3].sql, /^UPDATE pesquisa_satisfacao/);
	const used = await fixture(t, { used: true });
	assert.equal((await used.send(questionBatch())).status, 409);
	assert.equal(
		used.queries.some((q) => q.sql.startsWith("UPDATE")),
		false,
	);
	const invalid = await fixture(t);
	for (const mutate of [
		(b) => b.tables.push("clientes"),
		(b) => (b.questionId = -1),
		(b) => (b.statements[0].sql = "UPDATE operadores SET ATIVO='NAO'"),
		(b) => (b.actorId = 1),
	]) {
		const b = questionBatch();
		mutate(b);
		assert.equal((await invalid.send(b)).status, 400);
	}
	assert.equal(invalid.transactions.length, 0);
});
test("survey finalization shares the transaction, validates snapshot under lock, and checks triggers on every mutated table", async (t) => {
	const f = await fixture(t);
	const response = await f.send(surveyBatch());
	assert.equal(response.status, 200);
	assert.equal(response.body.data.length, 5);
	assert.equal(f.transactions.length, 1);
	assert.deepEqual(f.queries[0].params, [
		"campanhas_clientes",
		"historico_cli",
		"telephony_schedule_finishes",
		"telephony_satisfaction_submissions",
		"pesquisa_satisfacao_avaliacao",
	]);
	assert.equal(
		f.queries.find((q) =>
			q.sql.startsWith("INSERT INTO telephony_satisfaction_submissions"),
		).params[3],
		71,
	);
	assert.match(
		f.queries[2].sql,
		/pesquisa_satisfacao ORDER BY PESQSAT_CODIGO LIMIT 101 FOR UPDATE/,
	);
	const changed = await fixture(t, {
		questions: [{ PESQSAT_CODIGO: 1, PESQ_DESCRICAO: "Mudou" }],
	});
	assert.equal((await changed.send(surveyBatch())).status, 409);
	assert.equal(
		changed.queries.some((q) => q.sql.startsWith("UPDATE")),
		false,
	);
	const added = await fixture(t, {
		questions: [
			{ PESQSAT_CODIGO: 1, PESQ_DESCRICAO: "Atendimento?" },
			{ PESQSAT_CODIGO: 2, PESQ_DESCRICAO: "Nova" },
		],
	});
	assert.equal((await added.send(surveyBatch())).status, 409);
	const existing = await fixture(t, { existingSurvey: true });
	assert.equal((await existing.send(surveyBatch())).status, 409);
	assert.equal(
		existing.queries.some((q) => q.sql.startsWith("UPDATE")),
		false,
	);
	const triggers = await fixture(t, {
		triggers: [{ TRIGGER_NAME: "unknown" }],
	});
	assert.equal((await triggers.send(surveyBatch())).status, 503);
	assert.equal(triggers.queries.length, 1);
});
test("survey transport rejects partial, duplicate, foreign-question or foreign-schedule payloads before transaction", async (t) => {
	const f = await fixture(t);
	for (const mutate of [
		(b) => b.statements.pop(),
		(b) => b.tables.pop(),
		(b) => b.surveyQuestions.push(b.surveyQuestions[0]),
		(b) => (b.statements[4].params[0] = 42),
		(b) => (b.statements[4].params[1] = 2),
		(b) => (b.statements[4].params[2] = "6"),
		(b) => (b.statements[4].expectAffectedRows = 0),
		(b) => (b.surveyQuestions[0].tenant = "beta"),
		(b) =>
			(b.statements[3].sql =
				"INSERT INTO operadores (CODIGO) VALUES (?)"),
	]) {
		const b = surveyBatch();
		mutate(b);
		assert.equal((await f.send(b)).status, 400);
	}
	assert.equal(f.transactions.length, 0);
});
test("failed mandatory answer insert aborts with known outcome and no raw SQL", async (t) => {
	const f = await fixture(t, { failAnswers: true });
	const response = await f.send(surveyBatch());
	assert.deepEqual(response, {
		status: 503,
		body: {
			code: "TENANT_TRANSACTION_QUERY_FAILED",
			outcome: "NOT_COMMITTED",
		},
	});
	assert.equal(f.transactions.length, 1);
	const missing = await fixture(t, { missingHistoryId: true });
	assert.equal((await missing.send(surveyBatch())).status, 409);
	assert.equal(
		missing.queries.some((q) =>
			q.sql.startsWith("INSERT INTO telephony_satisfaction_submissions"),
		),
		false,
	);
	const mismatch = await fixture(t, { answerCount: 0 });
	assert.equal((await mismatch.send(surveyBatch())).status, 409);
});
function receiptColumns() {
	return [
		{
			COLUMN_NAME: "operation_key",
			DATA_TYPE: "varchar",
			CHARACTER_MAXIMUM_LENGTH: 80,
			IS_NULLABLE: "NO",
		},
		{
			COLUMN_NAME: "request_hash",
			DATA_TYPE: "char",
			CHARACTER_MAXIMUM_LENGTH: 64,
			IS_NULLABLE: "NO",
		},
		...["actor_id", "customer_id"].map((COLUMN_NAME) => ({
			COLUMN_NAME,
			DATA_TYPE: "int",
			CHARACTER_MAXIMUM_LENGTH: null,
			IS_NULLABLE: "NO",
		})),
		{
			COLUMN_NAME: "created_at",
			DATA_TYPE: "datetime",
			CHARACTER_MAXIMUM_LENGTH: null,
			IS_NULLABLE: "NO",
		},
	];
}
function importBatch() {
	const batch = phoneBatch(true);
	batch.tables.push("crm_import_receipts", "operadores");
	batch.importReceipt = {
		key: "a0000000-0000-4000-8000-000000000001:2",
		actorId: 7,
		identity: "phone",
		requestHash: "a".repeat(64),
	};
	return batch;
}
test("G12 binds receipt to actor and request inside the policy lock, commits only after N01 and duplicate checks", async (t) => {
	const f = await fixture(t, { phoneColumns: phoneColumns() });
	const body = importBatch();
	assert.deepEqual(await f.send(body), {
		status: 200,
		body: { data: [{ affectedRows: 1, insertId: 41 }] },
	});
	assert.ok(f.queries[0].params.includes("crm_import_receipts"));
	const policy = f.queries.findIndex((q) =>
			q.sql.startsWith("SELECT CODIGO FROM parametros"),
		),
		actor = f.queries.findIndex((q) =>
			q.sql.startsWith("SELECT CODIGO,ATIVO,NIVEL"),
		),
		receipt = f.queries.findIndex((q) =>
			q.sql.startsWith("SELECT request_hash,actor_id"),
		),
		insert = f.queries.findIndex((q) =>
			/^INSERT INTO `?clientes`?\s/.test(q.sql),
		),
		sync = f.queries.findIndex((q) =>
			q.sql.startsWith("INSERT INTO fones_campanha_cli"),
		),
		duplicate = f.queries.findIndex((q) =>
			q.sql.startsWith("SELECT CODIGO FROM clientes WHERE CODIGO<>?"),
		),
		saved = f.queries.findIndex((q) =>
			q.sql.startsWith("INSERT INTO crm_import_receipts"),
		);
	assert.ok(
		policy < actor &&
			actor < receipt &&
			receipt < insert &&
			insert < sync &&
			sync < duplicate &&
			duplicate < saved,
	);
	assert.deepEqual(f.queries[saved].params, [
		body.importReceipt.key,
		body.importReceipt.requestHash,
		7,
		41,
	]);
});
test("G12 repeated key returns the original insertId without customer/phone writes; mismatched request or actor fails closed", async (t) => {
	const body = importBatch(),
		row = {
			request_hash: body.importReceipt.requestHash,
			actor_id: 7,
			customer_id: 99,
		};
	const replay = await fixture(t, { importReceiptRows: [row] });
	assert.deepEqual(await replay.send(body), {
		status: 200,
		body: { data: [{ affectedRows: 1, insertId: 99 }] },
	});
	assert.ok(replay.queries.every((q) => q.sql.startsWith("SELECT")));
	for (const patch of [{ request_hash: "b".repeat(64) }, { actor_id: 8 }]) {
		const conflict = await fixture(t, {
			importReceiptRows: [{ ...row, ...patch }],
		});
		assert.equal(
			(await conflict.send(body)).body.code,
			"TENANT_IMPORT_OPERATION_REUSED",
		);
		assert.ok(conflict.queries.every((q) => q.sql.startsWith("SELECT")));
	}
	const denied = await fixture(t, { importActorDenied: true });
	assert.equal((await denied.send(body)).status, 403);
});
test("G12 rejects unsupported envelopes and metadata and refuses duplicate or failed receipt acknowledgement", async (t) => {
	const f = await fixture(t);
	for (const mutate of [
		(b) => (b.customerId = 1),
		(b) => delete b.syncPhones,
		(b) => b.tables.splice(b.tables.indexOf("crm_import_receipts"), 1),
		(b) => (b.importReceipt.key = b.importReceipt.key.replace(":2", ":1")),
		(b) => (b.importReceipt.requestHash = "A".repeat(64)),
		(b) => (b.importReceipt.sql = "INSERT INTO crm_import_receipts"),
		(b) => (b.importReceipt.identity = "all"),
		(b) =>
			b.statements.push({
				sql: "INSERT INTO motivo_desativacao_cliente (CLIENTE) SELECT ?",
				params: [1],
				expectAffectedRows: 1,
			}),
	]) {
		const body = importBatch();
		mutate(body);
		assert.equal((await f.send(body)).status, 400);
	}
	assert.equal(f.transactions.length, 0);
	const bad = await fixture(t, { badImportSchema: true });
	assert.equal(
		(await bad.send(importBatch())).body.code,
		"TENANT_IMPORT_RECEIPT_SCHEMA_UNSUPPORTED",
	);
	assert.ok(bad.queries.every((q) => q.sql.startsWith("SELECT")));
	const duplicate = await fixture(t, {
		phoneColumns: phoneColumns(),
		importDuplicate: true,
	});
	assert.equal(
		(await duplicate.send(importBatch())).body.code,
		"TENANT_IMPORT_DUPLICATE",
	);
	assert.ok(
		!duplicate.queries.some((q) =>
			q.sql.startsWith("INSERT INTO crm_import_receipts"),
		),
	);
	const failed = await fixture(t, {
		phoneColumns: phoneColumns(),
		importReceiptFailure: true,
	});
	assert.equal(
		(await failed.send(importBatch())).body.code,
		"TENANT_TRANSACTION_QUERY_FAILED",
	);
});
function combinedFinishBatch() {
	const b = surveyBatch();
	b.tables.push("propostas", "propostas_compras", "crm_proposal_events");
	b.statements.push(
		{
			sql: proposalSql.createSql,
			params: [41, "100.25", 41],
			expectAffectedRows: 1,
		},
		{
			sql: proposalSql.createEventSql,
			params: ["fixture-proposal", "a".repeat(64), 7, 41],
			expectAffectedRows: 1,
		},
	);
	return b;
}
test("proposal and satisfaction effects share one finish transaction and stable history injection", async (t) => {
	const f = await fixture(t),
		body = combinedFinishBatch(),
		response = await f.send(body);
	assert.equal(response.status, 200);
	assert.equal(response.body.data.length, 7);
	assert.equal(f.transactions.length, 1);
	const snapshot = f.queries.find((q) =>
		q.sql.startsWith("INSERT INTO telephony_satisfaction_submissions"),
	);
	assert.equal(snapshot.params[3], 71);
	assert.deepEqual(
		f.queries
			.filter((q) => /^(?:UPDATE|INSERT INTO)/.test(q.sql))
			.map((q) => q.sql),
		body.statements.map((s) => s.sql),
	);
	assert.ok(f.queries[0].params.includes("crm_proposal_events"));
	assert.ok(f.queries[0].params.includes("pesquisa_satisfacao_avaliacao"));
	const failing = await fixture(t, { failAnswers: true });
	assert.equal((await failing.send(body)).status, 503);
	assert.ok(!failing.queries.some((q) => q.sql === proposalSql.createSql));
	for (const mutate of [
		(b) => b.tables.splice(b.tables.indexOf("propostas_compras"), 1),
		(b) => b.statements.splice(3, 1),
		(b) =>
			(b.statements[5].sql =
				"INSERT INTO propostas (LIGACAO) VALUES (?)"),
	]) {
		const b = combinedFinishBatch();
		mutate(b);
		assert.equal((await f.send(b)).status, 400);
	}
});
test("survey SQL, snapshot and receipt cannot diverge even inside a signed combined finish", async (t) => {
	const f = await fixture(t);
	for (const mutate of [
		(b) =>
			(b.statements[4].sql +=
				" ON DUPLICATE KEY UPDATE PESQSAT_AVALIACAO='1'"),
		(b) => (b.statements[3].params[2] = 99),
		(b) => (b.statements[3].params[0] = "foreign-op"),
		(b) => (b.statements[3].params[4] = "{}"),
		(b) =>
			(b.statements[3].params[4] = JSON.stringify({
				questions: b.surveyQuestions,
				answers: [{ questionId: 1, rating: 4 }],
			})),
		(b) =>
			(b.statements[3].params[4] = JSON.stringify({
				questions: [{ id: 1, description: "Changed" }],
				answers: [{ questionId: 1, rating: 5 }],
			})),
		(b) => (b.statements[2].params[2] = 42),
	]) {
		const batch = combinedFinishBatch();
		mutate(batch);
		assert.equal((await f.send(batch)).status, 400);
	}
	assert.equal(f.transactions.length, 0);
});
