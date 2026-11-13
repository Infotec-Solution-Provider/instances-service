const test = require("node:test"),
	assert = require("node:assert/strict"),
	mysql = require("mysql2/promise"),
	fs = require("node:fs"),
	path = require("node:path"),
	{ randomUUID } = require("node:crypto");
const { TenantDatabase } = require("../dist/tenant-database/tenant-database");
const { tenantDatabaseConfig } = require("../dist/tenant-database/config");
const { createTenantMysqlPool } = require("../dist/tenant-database/mysql-pool");
const factory = (...args) => {
	const pool = createTenantMysqlPool(...args);
	return {
		end: () => pool.end(),
		acquire: async () => {
			const c = await pool.acquire();
			return {
				...c,
				control: (s) => c.control(s),
				release: () => c.release(),
				destroy: () => c.destroy(),
				execute: async (s, p) => {
					try {
						return await c.execute(s, p);
					} catch (e) {
						console.error("isolated fixture SQL:", s, e.code);
						throw e;
					}
				},
			};
		},
	};
};
const {
	runRuntime,
	afterTelephonyFinish,
} = require("../dist/telephony-runtime/runtime");
const {
	parseRuntimeCommand,
	runtimeTables,
} = require("../dist/telephony-runtime/contract");
for (const port of [13555, 13480])
	test(
		`runtime MySQL ${port}: durable attempts, reviews, pauses and rollback`,
		{ skip: process.env.RUN_TELEPHONY_RUNTIME_MYSQL !== "1" },
		async (t) => {
			const name = `telephony_runtime_${process.pid}_${Date.now()}`,
				admin = await mysql.createConnection({
					host: "127.0.0.1",
					port,
					user: "root",
					multipleStatements: true,
				});
			let db;
			try {
				await admin.query(
					`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`,
				);
				await admin.query(`USE \`${name}\``);
				await admin.query(
					`CREATE TABLE operadores(CODIGO INT PRIMARY KEY,NIVEL VARCHAR(10),ATIVO VARCHAR(3))ENGINE=InnoDB;INSERT INTO operadores VALUES(1,'ATIVO','SIM'),(2,'ADMIN','SIM'),(3,'ATIVO','SIM');CREATE TABLE clientes(CODIGO INT PRIMARY KEY,ATIVO VARCHAR(3))ENGINE=InnoDB;INSERT INTO clientes VALUES(1,'SIM'),(2,'NAO');CREATE TABLE campanhas_clientes(CODIGO INT PRIMARY KEY,CLIENTE INT,OPERADOR INT,CONCLUIDO VARCHAR(3),DT_AGENDAMENTO DATETIME)ENGINE=InnoDB;INSERT INTO campanhas_clientes VALUES(1,1,1,'NAO',NOW()),(2,2,1,'NAO',NOW());CREATE TABLE motivos_pausa(CODIGO INT PRIMARY KEY,DESCRICAO VARCHAR(100),TEMPO_MAX_SEG INT,PRODUTIVIDADE VARCHAR(3))ENGINE=InnoDB;INSERT INTO motivos_pausa VALUES(1,'Intervalo',60,'NAO'),(2,'Sem limite',0,'SIM');`,
				);
				db = new TenantDatabase(
					async (tenant) =>
						tenant === "fixture"
							? {
									tenant,
									host: "127.0.0.1",
									port,
									user: "root",
									password: "",
									database: name,
								}
							: null,
					{
						...tenantDatabaseConfig({}),
						transactionMs: 15000,
						waitMs: 5000,
						maxStatements: 300,
					},
					factory,
				);
				const command = (action, input = {}, actorId = 1) =>
					runRuntime(
						db,
						"fixture",
						parseRuntimeCommand({
							operation: "telephony.runtime",
							actorId,
							action,
							input,
						}),
					);
				await admin.query(
					"ALTER TABLE campanhas_clientes ADD OPERADOR_LIGACAO INT NULL, ADD TELEFONE_LIGADO VARCHAR(64) NULL, ADD DATA_HORA_LIG DATETIME NULL, ADD DATA_HORA_FIM DATETIME NULL",
				);
				assert.equal((await command("status")).enabled, false);
				for (const file of [
					"20261113-telephony-runtime.sql",
					"20261113-telephony-web-sessions.sql",
				])
					await admin.query(
						fs.readFileSync(
							path.join(__dirname, "../docs/sql", file),
							"utf8",
						),
					);
				await admin.query(
					"UPDATE telephony_runtime_policy SET enabled=1,allow_change_reason=1,preflight_hash=REPEAT('a',64) WHERE id=1",
				);
				const callId = randomUUID();
				await t.test(
					"same UUID retries do not create another attempt; inactive schedule denied",
					async () => {
						await command("prepare", {
							callId,
							direction: "outgoing",
							number: "1234",
							scheduleId: 1,
						});
						await command("prepare", {
							callId,
							direction: "outgoing",
							number: "1234",
							scheduleId: 1,
						});
						assert.equal(
							(
								await admin.query(
									"SELECT COUNT(*) AS n FROM telephony_calls",
								)
							)[0][0].n,
							1,
						);
						await assert.rejects(
							command("prepare", {
								callId,
								direction: "outgoing",
								number: "9999",
								scheduleId: 1,
							}),
							(e) =>
								e.code === "TENANT_TELEPHONY_OPERATION_REUSED",
						);
						await assert.rejects(
							command("prepare", {
								callId: randomUUID(),
								direction: "outgoing",
								number: "1234",
								scheduleId: 2,
							}),
							(e) =>
								[
									"TENANT_TELEPHONY_CALL_ACTIVE",
									"TENANT_TELEPHONY_SCHEDULE_UNAVAILABLE",
								].includes(e.code),
						);
					},
				);
				const event = (type, extra = {}) => ({
					callId,
					eventId: randomUUID(),
					type,
					occurredAt: new Date().toISOString(),
					...extra,
				});
				await t.test(
					"events idempotent, late answered does not reopen terminal, receipt survives new service",
					async () => {
						const sent = event("sent");
						await command("event", sent);
						await command("event", sent);
						await command("event", event("ended"));
						await command("event", event("answered"));
						const result = (await command("get", { callId }))
							.calls[0];
						assert.equal(result.state, "ended");
						assert.ok(result.answeredAt);
						assert.ok(result.endedAt);
						assert.equal(
							(
								await admin.query(
									"SELECT COUNT(*) AS n FROM telephony_call_events WHERE id=?",
									[sent.eventId],
								)
							)[0][0].n,
							1,
						);
						await assert.rejects(
							command("event", { ...sent, detail: "different" }),
							(e) =>
								e.code === "TENANT_TELEPHONY_OPERATION_REUSED",
						);
						await db.close();
						db = new TenantDatabase(
							async (tenant) => ({
								tenant,
								host: "127.0.0.1",
								port,
								user: "root",
								password: "",
								database: name,
							}),
							{
								...tenantDatabaseConfig({}),
								transactionMs: 15000,
								maxStatements: 300,
							},
						);
						await command("event", sent);
					},
				);
				await t.test(
					"review belongs to call owner and uses version/receipt",
					async () => {
						const input = {
							operationId: randomUUID(),
							callId,
							rating: "MÉDIA",
							comment: "Ruído",
							expectedVersion: 0,
						};
						assert.equal(
							(await command("review", input)).version,
							1,
						);
						assert.equal(
							(await command("review", input)).version,
							1,
						);
						await assert.rejects(
							command(
								"review",
								{ ...input, operationId: randomUUID() },
								2,
							),
							(e) =>
								e.code === "TENANT_TELEPHONY_CALL_UNAVAILABLE",
						);
						await assert.rejects(
							command("review", {
								...input,
								operationId: randomUUID(),
							}),
							(e) =>
								e.code === "TENANT_TELEPHONY_VERSION_CONFLICT",
						);
						assert.equal(
							(await command("list", { operatorId: 1 }, 2))
								.calls[0].rating,
							"MÉDIA",
						);
						await assert.rejects(
							command("list", { operatorId: 1 }, 3),
							(e) => e.code === "TENANT_TELEPHONY_FORBIDDEN",
						);
					},
				);
				await t.test(
					"pending pause activates only with finalization transaction, rollback retains pending",
					async () => {
						const state = await command("status");
						await command("pause", {
							operationId: randomUUID(),
							kind: "after_attendance",
							reasonId: 1,
							expectedVersion: state.version,
						});
						await assert.rejects(
							db.transaction(
								"fixture",
								"telephony.runtime",
								runtimeTables,
								async (tx) => {
									await afterTelephonyFinish(tx, {
										actorId: 1,
										scheduleId: 1,
										finishedAt: new Date().toISOString(),
									});
									throw new Error("force rollback");
								},
							),
						);
						assert.equal(
							(await command("status")).state,
							"pending",
						);
						assert.equal(
							(
								await admin.query(
									"SELECT COUNT(*) AS n FROM telephony_pause_segments",
								)
							)[0][0].n,
							0,
						);
						await db.transaction(
							"fixture",
							"telephony.runtime",
							runtimeTables,
							(tx) =>
								afterTelephonyFinish(tx, {
									actorId: 1,
									scheduleId: 1,
									finishedAt: new Date().toISOString(),
								}),
						);
						assert.equal((await command("status")).state, "paused");
						await assert.rejects(
							command("prepare", {
								callId: randomUUID(),
								direction: "outgoing",
								number: "1234",
							}),
							(e) => e.code === "TENANT_TELEPHONY_PAUSED",
						);
						const state2 = await command("status");
						await command("pause", {
							operationId: randomUUID(),
							kind: "change_reason",
							reasonId: 2,
							expectedVersion: state2.version,
						});
						assert.equal((await command("status")).maxSeconds, 0);
						const state3 = await command("status"),
							resume = {
								operationId: randomUUID(),
								kind: "resume",
								expectedVersion: state3.version,
							};
						await command("pause", resume);
						await command("pause", resume);
						assert.equal(
							(await command("status")).state,
							"available",
						);
					},
				);
				await t.test("PBX intents supersede obsolete requests and explicit retry retains desired state",async()=>{
					await admin.query("INSERT INTO telephony_pbx_members(operator_id,queue_name,member_interface,enabled) VALUES(3,'sales','SIP/103',1)");
					let state=await command('status',{},3);
					await command('pause',{operationId:randomUUID(),kind:'now',reasonId:1,expectedVersion:state.version},3);
					state=await command('status',{},3);
					await command('pause',{operationId:randomUUID(),kind:'resume',expectedVersion:state.version},3);
					const latest=(await command('pbx.pending',{},3)).intents;
					assert.equal(latest.length,1);assert.equal(latest[0].paused,0);
					await command('pbx.result',{id:latest[0].id,status:'failed'},3);
					state=await command('status',{},3);assert.equal(state.pbx.status,'failed');
					await command('pause',{operationId:randomUUID(),kind:'retry_pbx',expectedVersion:state.version},3);
					assert.equal((await command('pbx.pending',{},3)).intents.length,1);
					assert.equal((await command('status',{},3)).state,'available');
				});
				await t.test(
					"concurrent pause and outgoing prepare serialize on operator",
					async () => {
						const state = await command("status"),
							id = randomUUID();
						const results = await Promise.allSettled([
							command("pause", {
								operationId: randomUUID(),
								kind: "now",
								reasonId: 1,
								expectedVersion: state.version,
							}),
							command("prepare", {
								callId: id,
								direction: "outgoing",
								number: "1234",
							}),
						]);
						assert.equal(
							results.filter((x) => x.status === "fulfilled")
								.length,
							1,
						);
					},
				);
			} finally {
				if (db) await db.close();
				await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
				await admin.end();
			}
		},
	);
