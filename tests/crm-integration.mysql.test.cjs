const test = require("node:test"),
	assert = require("node:assert/strict");
const mysql = require("mysql2/promise"),
	express = require("express");
const { randomUUID, createHmac } = require("node:crypto"),
	{ createServer } = require("node:http"),
	{ once } = require("node:events"),
	{ readFileSync } = require("node:fs"),
	{ join } = require("node:path");
const { TenantDatabase } = require("../dist/tenant-database/tenant-database");
const { tenantDatabaseConfig } = require("../dist/tenant-database/config");
const {
	createTenantTransactionsRouter,
} = require("../dist/controllers/tenant-transactions.controller");
const {
	readSnapshot,
	snapshotVersion,
} = require("../dist/tenant-database/administration-snapshot");
const proposal = require("../dist/crm-proposals/sql");
const enabled = process.env.RUN_CRM_INTEGRATION_MYSQL === "true";
test(
	"integrated CRM on disposable MySQL: G12 receipts/N01, proposal+survey atomicity, tenants and administration",
	{ skip: !enabled, timeout: 120000 },
	async (t) => {
		const ports = require("./isolated-mysql-ports.cjs")(
			"CRM_INTEGRATION_MYSQL_PORT",
			[3308],
		);
		assert.equal(ports.length, 1);
		const port = ports[0];
		const admin = await mysql.createConnection({
			host: "127.0.0.1",
			port,
			user: "root",
			charset: "utf8mb4_unicode_ci",
			multipleStatements: false,
		});
		const prefix = `crm_integration_${process.pid}_${Date.now()}`,
			names = { alpha: prefix + "_a", beta: prefix + "_b" },
			created = [];
		const config = {
			...tenantDatabaseConfig({}),
			transactionMs: 20000,
			maxStatements: 200,
			maxParameterBytes: 2097152,
			activeGlobal: 4,
			activePerServer: 4,
		};
		const database = new TenantDatabase(
			async (tenant) =>
				names[tenant]
					? {
							tenant,
							host: "127.0.0.1",
							port,
							user: "root",
							password: "",
							database: names[tenant],
						}
					: null,
			config,
		);
		const key = "isolated-integration-signing-key-0123456789";
		const app = express();
		app.use(express.json({ limit: "1mb" }));
		app.use(
			createTenantTransactionsRouter(
				() => database,
				() => key,
			),
		);
		const server = createServer(app);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const base = `http://127.0.0.1:${server.address().port}`;
		const send = async (body, tenant = "alpha") => {
			const path = `/api/instances/${tenant}/transactions`,
				timestamp = String(Date.now()),
				nonce = randomUUID(),
				encoded = JSON.stringify(body),
				signature = createHmac("sha256", key)
					.update(`${timestamp}\n${nonce}\n${path}\n${encoded}`)
					.digest("hex");
			const response = await fetch(base + path, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-tenant-timestamp": timestamp,
					"x-tenant-nonce": nonce,
					"x-tenant-signature": signature,
				},
				body: encoded,
			});
			return { status: response.status, body: await response.json() };
		};
		async function sql(tenant, statement, values = []) {
			return (
				await admin.query(
					statement.replaceAll("$SCHEMA", `\`${names[tenant]}\``),
					values,
				)
			)[0];
		}
		async function count(tenant, table) {
			return Number(
				(
					await sql(
						tenant,
						`SELECT COUNT(*) n FROM $SCHEMA.\`${table}\``,
					)
				)[0].n,
			);
		}
		function importBody({
			key: operationKey = randomUUID() + ":2",
			hash = "a".repeat(64),
			doc = "12345678901",
			phone = "33333333",
			identity = "document",
		} = {}) {
			return {
				operation: "crm.customer.write",
				customerId: 0,
				syncPhones: true,
				importReceipt: {
					key: operationKey,
					actorId: 7,
					identity,
					requestHash: hash,
				},
				tables: [
					"clientes",
					"parametros",
					"operadores",
					"fones_campanha_cli",
					"crm_import_receipts",
				],
				statements: [
					{
						sql: "INSERT INTO clientes (RAZAO,CPF_CNPJ,AREA1,FONE1) VALUES (?,?,?,?)",
						params: ["Importado", doc, 11, phone],
						expectAffectedRows: 1,
					},
				],
			};
		}
		function finishBody(
			id,
			{ withProposal = true, withSurvey = true, cancel = null } = {},
		) {
			const operationId = randomUUID(),
				hash = "b".repeat(64),
				b = {
					operation: "telephony.schedule.finish",
					scheduleId: id,
					tables: [
						"campanhas_clientes",
						"historico_cli",
						"telephony_schedule_finishes",
						"resultados",
						"operadores",
					],
					statements: [
						{
							sql: "UPDATE campanhas_clientes SET CONCLUIDO='SIM',RESULTADO=? WHERE CODIGO=? AND OPERADOR=? AND CONCLUIDO='NAO'",
							params: [9, id, 7],
							expectAffectedRows: 1,
						},
						{
							sql: "INSERT INTO historico_cli (CLIENTE,CC_CODIGO,TELEFONE) VALUES (?,?,?)",
							params: [1, id, "historical-number"],
							expectAffectedRows: 1,
						},
						{
							sql: "INSERT INTO telephony_schedule_finishes (operation_id,request_hash,schedule_id,actor_id,created_at) VALUES (?,?,?,?,UTC_TIMESTAMP())",
							params: [operationId, hash, id, 7],
							expectAffectedRows: 1,
						},
					],
				};
			if (withSurvey) {
				b.surveyQuestions = [{ id: 1, description: "Atendimento?" }];
				b.tables.push(
					"pesquisa_satisfacao",
					"pesquisa_satisfacao_avaliacao",
					"telephony_satisfaction_submissions",
				);
				b.statements.push(
					{
						sql: "INSERT INTO telephony_satisfaction_submissions (operation_id,schedule_id,actor_id,history_id,survey_json,created_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP())",
						params: [
							operationId,
							id,
							7,
							null,
							JSON.stringify({
								questions: b.surveyQuestions,
								answers: [{ questionId: 1, rating: 5 }],
							}),
						],
						expectAffectedRows: 1,
					},
					{
						sql: "INSERT INTO pesquisa_satisfacao_avaliacao (CAMPCLI_CODIGO,PESQSAT_CODIGO,PESQSAT_AVALIACAO) VALUES (?,?,?)",
						params: [id, 1, "5"],
						expectAffectedRows: 1,
					},
				);
			}
			if (withProposal || cancel) {
				b.tables.push(
					"propostas",
					"propostas_compras",
					"crm_proposal_events",
				);
				if (withProposal)
					b.statements.push(
						{
							sql: proposal.createSql,
							params: [id, "100.25", id],
							expectAffectedRows: 1,
						},
						{
							sql: proposal.createEventSql,
							params: [operationId, hash, 7, id],
							expectAffectedRows: 1,
						},
					);
				if (cancel)
					b.statements.push(
						{
							sql: proposal.finishCancelSql,
							params: [
								cancel.proposalId,
								cancel.scheduleId,
								"50",
								"ATIVA",
								id,
								7,
								0,
							],
							expectAffectedRows: 1,
						},
						{
							sql: proposal.eventSql,
							params: [
								operationId,
								hash,
								cancel.proposalId,
								cancel.scheduleId,
								7,
								"CANCEL",
								"50",
								null,
								"ATIVA",
								"CANCELADA",
								"Finalizacao",
								1,
								3,
							],
							expectAffectedRows: 1,
						},
					);
			}
			return b;
		}
		async function resetFinish() {
			for (const table of [
				"crm_proposal_events",
				"propostas_compras",
				"propostas",
				"pesquisa_satisfacao_avaliacao",
				"telephony_satisfaction_submissions",
				"telephony_schedule_finishes",
				"historico_cli",
				"campanhas_clientes",
			])
				await sql("alpha", `DELETE FROM $SCHEMA.\`${table}\``);
			await sql(
				"alpha",
				"INSERT INTO $SCHEMA.campanhas_clientes (CODIGO,CLIENTE,CAMPANHA,OPERADOR,CONCLUIDO) VALUES(41,1,3,7,'NAO'),(40,1,3,7,'SIM')",
			);
		}
		try {
			for (const tenant of ["alpha", "beta"]) {
				const name = names[tenant];
				assert.match(name, /^crm_integration_\d+_\d+_[ab]$/);
				await admin.query(
					`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`,
				);
				created.push(name);
				await admin.query(`USE \`${name}\``);
				for (const file of [
					"tests/fixtures/crm-integration.sql",
					"docs/sql/20261103-crm-import-receipts.sql",
					"docs/sql/crm-administration-transfers.sql",
					"docs/sql/20261103-crm-client-block-queue.sql",
				])
					for (const statement of readFileSync(
						join(__dirname, "..", file),
						"utf8",
					)
						.replace(/^--.*$/gm, "")
						.split(";")
						.map((s) => s.trim())
						.filter(Boolean))
						await admin.query(statement);
			}
			await t.test(
				"G12 repeats key without duplicate, rejects changed hash and isolates tenants",
				async () => {
					const body = importBody(),
						first = await send(body);
					assert.equal(first.status, 200, JSON.stringify(first));
					const replay = await send(body);
					assert.deepEqual(replay, first);
					assert.equal(await count("alpha", "clientes"), 1);
					assert.equal(await count("alpha", "fones_campanha_cli"), 1);
					assert.equal(
						await count("alpha", "crm_import_receipts"),
						1,
					);
					assert.equal(await count("beta", "clientes"), 0);
					const changed = structuredClone(body);
					changed.importReceipt.requestHash = "c".repeat(64);
					assert.equal(
						(await send(changed)).body.code,
						"TENANT_IMPORT_OPERATION_REUSED",
					);
					assert.equal((await send(body, "beta")).status, 200);
				},
			);
			await t.test(
				"two import rows with same document serialize despite permissive policy",
				async () => {
					const bodies = [
							importBody({
								doc: "98765432109",
								phone: "33334444",
							}),
							importBody({
								doc: "98765432109",
								phone: "33335555",
							}),
						],
						results = await Promise.all(bodies.map((b) => send(b)));
					assert.equal(
						results.filter((r) => r.status === 200).length,
						1,
						JSON.stringify(results),
					);
					assert.equal(
						results.filter(
							(r) => r.body.code === "TENANT_IMPORT_DUPLICATE",
						).length,
						1,
					);
					assert.equal(
						(
							await sql(
								"alpha",
								"SELECT CODIGO FROM $SCHEMA.clientes WHERE CPF_CNPJ='98765432109'",
							)
						).length,
						1,
					);
				},
			);
			await t.test(
				"phone identity compares every position without rewriting historical number",
				async () => {
					await sql(
						"alpha",
						"INSERT INTO $SCHEMA.clientes(RAZAO,AREA1,FONE1,AREA2,FONE2) VALUES('Legado',11,'33336666',11,'33337777')",
					);
					await sql(
						"alpha",
						"INSERT INTO $SCHEMA.historico_cli(CLIENTE,CC_CODIGO,TELEFONE) VALUES(1,99,'historical-number')",
					);
					const before = await count("alpha", "clientes");
					assert.equal(
						(
							await send(
								importBody({
									doc: null,
									phone: "33337777",
									identity: "phone",
								}),
							)
						).body.code,
						"TENANT_IMPORT_DUPLICATE",
					);
					assert.equal(await count("alpha", "clientes"), before);
					assert.equal(
						(
							await sql(
								"alpha",
								"SELECT TELEFONE FROM $SCHEMA.historico_cli WHERE CC_CODIGO=99",
							)
						)[0].TELEFONE,
						"historical-number",
					);
				},
			);
			await t.test(
				"failed receipt INSERT rolls back the customer and phone synchronization",
				async () => {
					await sql(
						"alpha",
						"ALTER TABLE $SCHEMA.crm_import_receipts ADD CONSTRAINT fixture_reject_receipt CHECK (request_hash <> REPEAT('d',64))",
					);
					const counts = await Promise.all(
							[
								"clientes",
								"fones_campanha_cli",
								"crm_import_receipts",
							].map((table) => count("alpha", table)),
						),
						response = await send(
							importBody({
								doc: "11122233344",
								phone: "33338888",
								hash: "d".repeat(64),
							}),
						);
					assert.notEqual(response.status, 200);
					assert.deepEqual(
						await Promise.all(
							[
								"clientes",
								"fones_campanha_cli",
								"crm_import_receipts",
							].map((table) => count("alpha", table)),
						),
						counts,
					);
					await sql(
						"alpha",
						"ALTER TABLE $SCHEMA.crm_import_receipts DROP CHECK fixture_reject_receipt",
					);
				},
			);
			await t.test(
				"finish creates proposal, cancels selection and persists survey pointing at exact history",
				async () => {
					await resetFinish();
					await sql(
						"alpha",
						"INSERT INTO $SCHEMA.propostas(LIGACAO,VALOR,SITUACAO) VALUES(40,50,'ATIVA')",
					);
					const old = (
						await sql(
							"alpha",
							"SELECT CODIGO FROM $SCHEMA.propostas WHERE LIGACAO=40",
						)
					)[0].CODIGO;
					const body = finishBody(41, {
							cancel: { proposalId: old, scheduleId: 40 },
						}),
						result = await send(body);
					assert.equal(result.status, 200, JSON.stringify(result));
					assert.equal(result.body.data.length, 9);
					const history = (
						await sql(
							"alpha",
							"SELECT CODIGO FROM $SCHEMA.historico_cli WHERE CC_CODIGO=41",
						)
					)[0].CODIGO;
					assert.equal(
						(
							await sql(
								"alpha",
								"SELECT history_id FROM $SCHEMA.telephony_satisfaction_submissions",
							)
						)[0].history_id,
						history,
					);
					assert.equal(
						(
							await sql(
								"alpha",
								"SELECT PESQSAT_AVALIACAO FROM $SCHEMA.pesquisa_satisfacao_avaliacao",
							)
						)[0].PESQSAT_AVALIACAO,
						"5",
					);
					assert.equal(
						(
							await sql(
								"alpha",
								"SELECT SITUACAO FROM $SCHEMA.propostas WHERE CODIGO=?",
								[old],
							)
						)[0].SITUACAO,
						"CANCELADA",
					);
					assert.equal(
						await count("alpha", "crm_proposal_events"),
						2,
					);
					assert.notEqual((await send(body)).status, 200);
					assert.equal(await count("alpha", "historico_cli"), 1);
				},
			);
			await t.test(
				"failure of each mandatory mutation rolls back the complete finish",
				async () => {
					for (const table of [
						"campanhas_clientes",
						"historico_cli",
						"telephony_schedule_finishes",
						"telephony_satisfaction_submissions",
						"pesquisa_satisfacao_avaliacao",
						"propostas",
						"crm_proposal_events",
					]) {
						await resetFinish();
						const field =
							table === "campanhas_clientes"
								? "CODIGO <> 41 OR CONCLUIDO <> 'SIM'"
								: table === "historico_cli"
									? "CC_CODIGO <> 41"
									: table === "telephony_schedule_finishes" ||
										  table ===
												"telephony_satisfaction_submissions"
										? "schedule_id <> 41"
										: table ===
											  "pesquisa_satisfacao_avaliacao"
											? "CAMPCLI_CODIGO <> 41"
											: table === "propostas"
												? "LIGACAO <> 41"
												: "schedule_id <> 41";
						await sql(
							"alpha",
							`ALTER TABLE $SCHEMA.\`${table}\` ADD CONSTRAINT fixture_fail_stage CHECK (${field})`,
						);
						const response = await send(finishBody(41));
						assert.notEqual(response.status, 200, table);
						assert.equal(
							(
								await sql(
									"alpha",
									"SELECT CONCLUIDO FROM $SCHEMA.campanhas_clientes WHERE CODIGO=41",
								)
							)[0].CONCLUIDO,
							"NAO",
							table,
						);
						for (const check of [
							"historico_cli",
							"telephony_schedule_finishes",
							"telephony_satisfaction_submissions",
							"pesquisa_satisfacao_avaliacao",
							"propostas",
							"crm_proposal_events",
						])
							assert.equal(
								await count("alpha", check),
								0,
								`${table} left ${check}`,
							);
						await sql(
							"alpha",
							`ALTER TABLE $SCHEMA.\`${table}\` DROP CHECK fixture_fail_stage`,
						);
					}
				},
			);
			await t.test(
				"G21 transfer is atomic, idempotent and rejects stale ownership",
				async () => {
					await resetFinish();
					await sql(
						"alpha",
						"UPDATE $SCHEMA.clientes SET OPERADOR=10 WHERE CODIGO=1",
					);
					await sql(
						"alpha",
						"UPDATE $SCHEMA.campanhas_clientes SET OPERADOR=10 WHERE CODIGO=41",
					);
					await sql(
						"alpha",
						"INSERT INTO $SCHEMA.fidelizacoes VALUES(1,1,10,41,8)",
					);
					const snapshot = await database.transaction(
						"alpha",
						"fixture.preview",
						[
							"clientes",
							"operadores",
							"campanhas_clientes",
							"fidelizacoes",
						],
						(tx) => readSnapshot(tx.execute, "alpha", [1], 10, 20),
					);
					const command = {
						operation: "crm.administration.transfer",
						operationId: randomUUID(),
						actorId: 7,
						source: 10,
						destination: 20,
						customerIds: [1],
						version: snapshotVersion(
							"alpha",
							[1],
							10,
							20,
							snapshot,
						),
					};
					const result = await send(command);
					assert.equal(result.status, 200, JSON.stringify(result));
					assert.deepEqual(await send(command), result);
					assert.equal(
						(
							await sql(
								"alpha",
								"SELECT OPERADOR FROM $SCHEMA.clientes WHERE CODIGO=1",
							)
						)[0].OPERADOR,
						20,
					);
					assert.equal(
						(
							await sql(
								"alpha",
								"SELECT QTDE_FIDELIZAR FROM $SCHEMA.fidelizacoes",
							)
						)[0].QTDE_FIDELIZAR,
						8,
					);
					assert.equal(
						await count("alpha", "crm_administration_transfers"),
						1,
					);
					assert.notEqual(
						(await send({ ...command, operationId: randomUUID() }))
							.status,
						200,
					);
				},
			);
		} finally {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
			await database.close();
			for (const name of created) {
				assert.match(name, /^crm_integration_\d+_\d+_[ab]$/);
				await admin.query(`DROP DATABASE \`${name}\``);
			}
			await admin.end();
		}
	},
);
