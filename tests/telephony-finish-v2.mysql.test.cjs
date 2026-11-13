const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");
const { randomUUID, createHash } = require("node:crypto");
const {
	finishTelephonyV2,
	finishV2Tables,
} = require("../dist/telephony-finish-v2/finish");
const { runTenantTransaction } = require("../dist/tenant-database/transaction");
const { tenantDatabaseConfig } = require("../dist/tenant-database/config");
const { afterTelephonyFinish } = require("../dist/telephony-runtime/runtime");
const { parseFinishV2 } = require("../dist/telephony-finish-v2/contract");
const ports = (process.env.FINISH_V2_MYSQL_PORTS || "")
	.split(",")
	.filter(Boolean)
	.map(Number);
const ddl = [
	`CREATE TABLE operadores(CODIGO INT PRIMARY KEY,LOGIN VARCHAR(35),NOME VARCHAR(35),ATIVO VARCHAR(3),NIVEL VARCHAR(10)) ENGINE=InnoDB`,
	`CREATE TABLE clientes(CODIGO INT PRIMARY KEY,ATIVO VARCHAR(3),OPERADOR INT,OPERADOR_LOGIN VARCHAR(35),COD_UNIDADE INT,COD_CAMPANHA INT,DATA_ULT_COMPRA DATE NULL,PERIODO_RECOMPRA INT,POSSUI_ORCAMENTO CHAR(1),POSSUI_VENDA CHAR(1),DT_ULTIMO_ORCAMENTO_VENDA DATETIME NULL) ENGINE=InnoDB`,
	`CREATE TABLE campanhas(CODIGO INT PRIMARY KEY,NOME VARCHAR(30),UNIDADE INT,TIPO VARCHAR(12)) ENGINE=InnoDB`,
	`CREATE TABLE unidades(CODIGO INT PRIMARY KEY,INATIVOS_RECENTES INT) ENGINE=InnoDB`,
	`CREATE TABLE campanhas_clientes(CODIGO INT AUTO_INCREMENT PRIMARY KEY,CLIENTE INT,CAMPANHA INT,OPERADOR INT,CONCLUIDO VARCHAR(3),DT_AGENDAMENTO DATETIME NULL,RESULTADO INT,DT_RESULTADO DATE NULL,OPERADOR_LIGACAO INT,DATA_HORA_LIG DATETIME NULL,DATA_HORA_FIM DATETIME NULL,TELEFONE_LIGADO VARCHAR(15),FONE1 VARCHAR(15),FONE2 VARCHAR(15),FONE3 VARCHAR(15),DESC_FONE1 VARCHAR(30),DESC_FONE2 VARCHAR(30),DESC_FONE3 VARCHAR(30),ORDEM INT,AGENDA INT,FIDELIZA CHAR(1),KEY client_call(CLIENTE,CODIGO)) ENGINE=InnoDB`,
	`CREATE TABLE resultados(CODIGO INT PRIMARY KEY,NOME VARCHAR(30),TIPO VARCHAR(8),COD_ACAO INT,PROPOSTA VARCHAR(3),CANCELAPROPOSTA VARCHAR(3),PESQUISA_SATISFACAO CHAR(1),EVENDA VARCHAR(3),ECONTATO VARCHAR(3),FIDELIZARCOTACAO VARCHAR(3),QTDE_FIDELIZARCOTACAO INT,PRIORIDADE VARCHAR(3)) ENGINE=InnoDB`,
	`CREATE TABLE parametros(CODIGO INT PRIMARY KEY,PERMITE_FINALIZAR_SEM_OBS CHAR(1),EXIGIR_FASE_CONTATO CHAR(1),EXIBIR_FASE_CONTATO CHAR(1),OCULTAR_ALTAPRIORIDADE CHAR(1),AGENDAMENTO_SUPERVISOR CHAR(1),FIDELIZACAO_ZERO CHAR(1),CARTEIRA_FIXA_OPERADOR CHAR(1),HABILITAR_CLIENTES_BLOQUEADOS CHAR(1),DIAS_LIMITE_AGENDAMENTO INT,BLOQ_LIMITE_AGENDAMENTO_DIA CHAR(1),LIMITE_AGENDAMENTO_DIA INT,VALIDA_AGENDAMENTOS CHAR(1),BLOQUEAR_AGENDAMENTO_FORA_PERIODO_RECOMPRA CHAR(1)) ENGINE=InnoDB`,
	`CREATE TABLE historico_cli(CODIGO INT AUTO_INCREMENT PRIMARY KEY,CAMPANHA VARCHAR(30),ATIVO_RECEP VARCHAR(8),OPERADOR VARCHAR(35),DATAHORA_INICIO DATETIME,DATAHORA_FIM DATETIME,RESULTADO INT,TELEFONE VARCHAR(15),OBSERVACAO TEXT,CLIENTE INT,CC_CODIGO INT,CODIGO_FASE_CONTATO INT NULL) ENGINE=InnoDB`,
	`CREATE TABLE fidelizacoes(CODIGO INT AUTO_INCREMENT PRIMARY KEY,cliente INT,cc_codigo INT,cod_origem INT,qtde_fidelizar INT,dt_criacao DATETIME,operador_criacao INT,KEY client_fid(cliente,CODIGO)) ENGINE=InnoDB`,
	`CREATE TABLE transferencia_clientes(CODIGO INT PRIMARY KEY,DATA_HORA DATETIME) ENGINE=InnoDB`,
	`CREATE TABLE transferencia_clientes_itens(CODIGO INT,CLIENTE INT) ENGINE=InnoDB`,
	`CREATE TABLE propostas(CODIGO INT AUTO_INCREMENT PRIMARY KEY,LIGACAO INT,VALOR DOUBLE,SITUACAO VARCHAR(12)) ENGINE=InnoDB`,
	`CREATE TABLE propostas_compras(PROPOSTA INT,COMPRA INT,PRIMARY KEY(PROPOSTA,COMPRA)) ENGINE=InnoDB`,
	`CREATE TABLE crm_proposal_events(operation_id CHAR(36),request_hash CHAR(64),proposal_id INT,schedule_id INT,actor_id INT,action VARCHAR(12),old_value VARCHAR(30),new_value VARCHAR(30),old_status VARCHAR(12),new_status VARCHAR(12),reason TEXT,customer_id INT,campaign_id INT,created_at DATETIME) ENGINE=InnoDB`,
	`CREATE TABLE compras(CODIGO INT AUTO_INCREMENT PRIMARY KEY,CLIENTE INT,OPERADOR INT,DATA DATE,DESCRICAO VARCHAR(60),VALOR DOUBLE,FORMA_PGTO VARCHAR(255)) ENGINE=InnoDB`,
	`CREATE TABLE pesquisa_satisfacao(PESQSAT_CODIGO INT PRIMARY KEY,PESQ_DESCRICAO VARCHAR(1000)) ENGINE=InnoDB`,
	`CREATE TABLE pesquisa_satisfacao_avaliacao(CAMPCLI_CODIGO INT,PESQSAT_CODIGO INT,PESQSAT_AVALIACAO VARCHAR(1),PRIMARY KEY(CAMPCLI_CODIGO,PESQSAT_CODIGO)) ENGINE=InnoDB`,
	`CREATE TABLE telephony_satisfaction_submissions(operation_id CHAR(36) PRIMARY KEY,schedule_id INT,actor_id INT,history_id INT,survey_json LONGTEXT,created_at DATETIME) ENGINE=InnoDB`,
	`CREATE TABLE motivo_desativacao_cliente(OPERADOR INT,CLIENTE INT,DATAHORA DATETIME,MOTIVO TEXT) ENGINE=InnoDB`,
	`CREATE TABLE cliente_bloqueado(CODIGO INT AUTO_INCREMENT PRIMARY KEY,CODIGO_CAMPANHA_CLIENTE INT,BLOQUEADO CHAR(1)) ENGINE=InnoDB`,
	`CREATE TABLE campanhas_clientes_log(CODIGO INT,DATA_HORA DATETIME,OPERADOR INT,CAMPO VARCHAR(30),OLD_VALOR TEXT,NEW_VALOR TEXT,MODULO VARCHAR(50)) ENGINE=InnoDB`,
	`CREATE TABLE fase_contato(CODIGO INT PRIMARY KEY,NOME VARCHAR(50),EXIGE_OBSERVACAO CHAR(1)) ENGINE=InnoDB`,
	`CREATE TABLE motivos_pausa(CODIGO INT PRIMARY KEY,DESCRICAO VARCHAR(50),TEMPO_MAX_SEG INT,PRODUTIVIDADE VARCHAR(3)) ENGINE=InnoDB`,
];
test(
	"finish v2 MySQL integration requires explicit isolated loopback ports",
	{ skip: !ports.length },
	() => assert.ok(ports.length),
);
for (const port of ports)
	test(`finish v2 atomic effects on isolated MySQL ${port}`, async (t) => {
		assert.ok(
			[13555, 13480].includes(port),
			"only this task owned local ports are permitted",
		);
		const database = `telephony_finish_test_${process.pid}_${port}`;
		const conn = await mysql.createConnection({
			host: "127.0.0.1",
			port,
			user: "root",
			password: "",
			dateStrings: true,
		});
		await conn.query(
			`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`,
		);
		try {
			await conn.query(`USE \`${database}\``);
			for (const sql of ddl) await conn.query(sql);
			for (const file of ["20261113-telephony-runtime.sql"])
				for (const statement of fs
					.readFileSync(
						path.join(__dirname, "../docs/sql", file),
						"utf8",
					)
					.replace(/^--.*$/gm, "")
					.split(";")
					.filter((x) => x.trim()))
					await conn.query(statement);
			const finishDdl = fs.readFileSync(
				path.join(
					__dirname,
					"../../customers-service/docs/sql/20261113-telephony-finish-v2.sql",
				),
				"utf8",
			);
			for (const statement of finishDdl
				.replace(/^--.*$/gm, "")
				.split(";")
				.filter((x) => x.trim()))
				await conn.query(statement);
			const tx = {
				tenant: "fixture",
				execute: async (sql, params = []) => {
					const [r] = await conn.query(sql, params);
					return r;
				},
			};
			const reset = async () => {
				for (const table of [
					"telephony_finish_operations",
					"campanhas_clientes",
					"historico_cli",
					"fidelizacoes",
					"propostas_compras",
					"propostas",
					"crm_proposal_events",
					"compras",
					"pesquisa_satisfacao_avaliacao",
					"telephony_satisfaction_submissions",
					"motivo_desativacao_cliente",
					"cliente_bloqueado",
					"campanhas_clientes_log",
					"transferencia_clientes_itens",
					"transferencia_clientes",
					"fase_contato",
				])
					await conn.query(`DELETE FROM ${table}`);
				await conn.query(
					"REPLACE INTO operadores VALUES (7,'operador','Operador','SIM','ATIVO'),(8,'colega','Colega','SIM','ATIVO')",
				);
				await conn.query(
					"REPLACE INTO clientes VALUES (3,'SIM',7,'operador',1,2,NULL,30,'S','N',NULL)",
				);
				await conn.query(
					"REPLACE INTO campanhas VALUES(2,'Campanha',1,'PROSPE')",
				);
				await conn.query(
					"REPLACE INTO parametros VALUES (1,'N','N','N','N','N','N','N','N',90,'N',0,'N','N')",
				);
				await conn.query(
					"REPLACE INTO resultados VALUES (9,'Resultado','ATIVO',20,'NAO','NAO','N','NAO','SIM','SIM',3,'NAO')",
				);
				await conn.query(
					"INSERT INTO campanhas_clientes (CODIGO,CLIENTE,CAMPANHA,OPERADOR,CONCLUIDO,DT_AGENDAMENTO,DATA_HORA_LIG,TELEFONE_LIGADO,FONE1,ORDEM,AGENDA,FIDELIZA) VALUES(41,3,2,7,'NAO','2026-11-13 08:00:00','2026-11-13 09:00:00','51999999999','51999999999',1,0,'S')",
				);
				await conn.query(
					"UPDATE telephony_finish_policy SET enabled=1,exclusive_writer=1,preflight_revision=REPEAT('a',64),sale_enabled=0,fidelize_on_sale=0,first_contact_assignment=0 WHERE id=1",
				);
				await conn.query(
					"SET @inpulse_crm_transfer_at='2026-11-13 10:00:00',@inpulse_crm_utc_at='2026-11-13 13:00:00'",
				);
				await conn.query(
					"UPDATE telephony_operator_state SET state='available',active_call_id=NULL,pending_schedule_id=NULL,pause_id=NULL,reason_id=NULL",
				);
			};
			const input = (extra = {}) =>
				parseFinishV2({
					operation: "telephony.schedule.finish.v2",
					scheduleId: 41,
					actorId: 7,
					command: {
						operationId: randomUUID(),
						resultId: 9,
						observation: "Atendimento concluido.",
						...extra,
					},
				});
			const run = async (command, hook) => {
				await conn.beginTransaction();
				try {
					const receipt = await finishTelephonyV2(
						tx,
						command,
						hook ? { afterFinish: hook } : {},
					);
					await conn.commit();
					return receipt;
				} catch (e) {
					await conn.rollback();
					throw e;
				}
			};
			await t.test(
				"concludes current, creates +4d successor, preserves observation and exact idempotent receipt",
				async () => {
					await reset();
					const command = input();
					const receipt = await run(command);
					assert.ok(receipt.successorScheduleId);
					const [rows] = await conn.query(
						"SELECT CODIGO,CONCLUIDO,DT_AGENDAMENTO FROM campanhas_clientes ORDER BY CODIGO",
					);
					assert.equal(rows[0].CONCLUIDO, "SIM");
					assert.equal(rows[1].DT_AGENDAMENTO, "2026-11-17 10:00:00");
					assert.deepEqual(await run(command), receipt);
					const [[counts]] = await conn.query(
						"SELECT COUNT(*) n FROM fidelizacoes",
					);
					assert.equal(counts.n, 1);
					const [[history]] = await conn.query(
						"SELECT OBSERVACAO FROM historico_cli",
					);
					assert.equal(history.OBSERVACAO, "Atendimento concluido.");
					await assert.rejects(
						run({
							...command,
							command: {
								...command.command,
								observation: "Alterado",
							},
						}),
						/operação|opera/,
					);
				},
			);
			await t.test(
				"hook failure rolls back every effect and receipt",
				async () => {
					await reset();
					await assert.rejects(
						run(input(), async () => {
							throw Error("pause failed");
						}),
						/pause failed/,
					);
					const [[schedule]] = await conn.query(
						"SELECT CONCLUIDO FROM campanhas_clientes WHERE CODIGO=41",
					);
					assert.equal(schedule.CONCLUIDO, "NAO");
					for (const table of [
						"historico_cli",
						"fidelizacoes",
						"telephony_finish_operations",
					]) {
						const [[r]] = await conn.query(
							`SELECT COUNT(*) n FROM ${table}`,
						);
						assert.equal(r.n, 0);
					}
				},
			);
			await t.test(
				"real runtime hook starts a pending pause in the same committed finalization",
				async () => {
					await reset();
					await conn.query(
						"REPLACE INTO motivos_pausa VALUES(1,'Intervalo',600,'NAO')",
					);
					await conn.query(
						"UPDATE telephony_operator_state SET state='pending',reason_id=1,pending_schedule_id=41 WHERE operator_id=7",
					);
					const receipt = await run(input(), afterTelephonyFinish);
					const [[state]] = await conn.query(
						"SELECT state,pending_schedule_id,pause_id FROM telephony_operator_state WHERE operator_id=7",
					);
					assert.equal(state.state, "paused");
					assert.equal(state.pending_schedule_id, null);
					assert.ok(state.pause_id);
					const [[r]] = await conn.query(
						"SELECT result_json FROM telephony_finish_operations WHERE operation_id=?",
						[receipt.operationId],
					);
					assert.equal(
						JSON.parse(r.result_json).historyId,
						receipt.historyId,
					);
				},
			);
			await t.test(
				"delegation creates colleague agenda without changing customer owner",
				async () => {
					await reset();
					await conn.query("UPDATE resultados SET COD_ACAO=8");
					const r = await run(
						input({
							scheduleDate: "2026-11-14T10:30",
							delegateOperatorId: 8,
						}),
					);
					const [[s]] = await conn.query(
						"SELECT OPERADOR,AGENDA,FIDELIZA FROM campanhas_clientes WHERE CODIGO=?",
						[r.successorScheduleId],
					);
					assert.deepEqual(s, {
						OPERADOR: 8,
						AGENDA: -240,
						FIDELIZA: "S",
					});
					const [[c]] = await conn.query(
						"SELECT OPERADOR FROM clientes",
					);
					assert.equal(c.OPERADOR, 7);
				},
			);
			await t.test(
				"non-loyal successor uses customer owner or public agenda, while redial stays with caller",
				async () => {
					for (const owner of [8, 0]) {
						await reset();
						await conn.query(
							"UPDATE resultados SET FIDELIZARCOTACAO='NAO',ECONTATO='NAO'",
						);
						await conn.query("UPDATE clientes SET OPERADOR=?", [
							owner,
						]);
						const receipt = await run(input());
						const [[row]] = await conn.query(
							"SELECT OPERADOR,FIDELIZA FROM campanhas_clientes WHERE CODIGO=?",
							[receipt.successorScheduleId],
						);
						assert.equal(row.OPERADOR, owner);
						assert.equal(row.FIDELIZA, null);
					}
					await reset();
					await conn.query(
						"UPDATE resultados SET COD_ACAO=1,FIDELIZARCOTACAO='NAO',ECONTATO='NAO'",
					);
					await conn.query("UPDATE clientes SET OPERADOR=8");
					const receipt = await run(
						input({ redialPhone: "51988888888" }),
					);
					const [[row]] = await conn.query(
						"SELECT OPERADOR,FIDELIZA,FONE1,FONE2 FROM campanhas_clientes WHERE CODIGO=?",
						[receipt.successorScheduleId],
					);
					assert.equal(row.OPERADOR, 7);
					assert.equal(row.FIDELIZA, "S");
					assert.equal(row.FONE1, "51988888888");
					assert.equal(row.FONE2, "");
				},
			);
			await t.test(
				"inactivation creates no successor and tracks reason/block request",
				async () => {
					await reset();
					await conn.query("UPDATE resultados SET COD_ACAO=6");
					await conn.query(
						"UPDATE parametros SET HABILITAR_CLIENTES_BLOQUEADOS='S'",
					);
					const r = await run(input({ confirmInactivation: true }));
					assert.equal(r.successorScheduleId, null);
					const [[c]] = await conn.query(
						"SELECT ATIVO FROM clientes",
					);
					assert.equal(c.ATIVO, "NAO");
					const [[b]] = await conn.query(
						"SELECT CODIGO_CAMPANHA_CLIENTE FROM cliente_bloqueado",
					);
					assert.equal(b.CODIGO_CAMPANHA_CLIENTE, 41);
				},
			);
			await t.test(
				"sale and proposal and survey are committed together with the same history",
				async () => {
					await reset();
					await conn.query(
						"UPDATE resultados SET EVENDA='SIM',PROPOSTA='SIM',PESQUISA_SATISFACAO='S'",
					);
					await conn.query(
						"UPDATE telephony_finish_policy SET sale_enabled=1",
					);
					await conn.query(
						"REPLACE INTO pesquisa_satisfacao VALUES(1,'Como foi?')",
					);
					const r = await run(
						input({
							proposalValue: "150.25",
							sale: {
								description: "Venda fixture",
								value: "150.25",
								paymentMethod: "PIX",
								proposalIds: [],
							},
							survey: {
								questions: [
									{ id: 1, description: "Como foi?" },
								],
								answers: [{ questionId: 1, rating: 5 }],
							},
						}),
					);
					assert.ok(r.saleId);
					const [[s]] = await conn.query(
						"SELECT history_id FROM telephony_satisfaction_submissions",
					);
					assert.equal(s.history_id, r.historyId);
					const [[count]] = await conn.query(
						"SELECT COUNT(*) n FROM propostas",
					);
					assert.equal(count.n, 1);
				},
			);
			await t.test(
				"twenty cancellations and twenty sale links fit the real bounded transaction and respect proposal versions",
				async () => {
					await reset();
					await conn.query(
						"UPDATE resultados SET EVENDA='SIM',CANCELAPROPOSTA='SIM'",
					);
					await conn.query(
						"UPDATE telephony_finish_policy SET sale_enabled=1",
					);
					for (let i = 0; i < 40; i++)
						await conn.query(
							"INSERT INTO propostas(LIGACAO,VALOR,SITUACAO) VALUES(41,?,'ATIVA')",
							[10 + i],
						);
					const [rows] = await conn.query(
						"SELECT CODIGO id,LIGACAO scheduleId,CAST(VALOR AS CHAR) value,SITUACAO status FROM propostas ORDER BY CODIGO",
					);
					const cancelProposals = rows.slice(0, 20).map((p) => ({
						id: p.id,
						version: createHash("sha256")
							.update(
								JSON.stringify([
									"fixture",
									p.id,
									p.scheduleId,
									p.value,
									p.status,
									0,
									0,
								]),
							)
							.digest("hex"),
					}));
					const cmd = input({
						cancelProposals,
						sale: {
							description: "Venda muitas propostas",
							value: "999.90",
							paymentMethod: "PIX",
							proposalIds: rows.slice(20).map((p) => p.id),
						},
					});
					const adapter = {
						execute: async (sql, params) => {
							const [r] = await conn.query(sql, params);
							return r;
						},
						control: async (sql) => {
							await conn.query(sql);
						},
						release() {},
						destroy() {
							conn.destroy();
						},
					};
					const receipt = await runTenantTransaction(
						adapter,
						"fixture",
						finishV2Tables,
						tenantDatabaseConfig({
							TENANT_DB_TRANSACTION_MS: "10000",
						}),
						(tx) => finishTelephonyV2(tx, cmd),
						true,
					);
					assert.ok(receipt.saleId);
					const [[counts]] = await conn.query(
						"SELECT COUNT(*) n FROM propostas WHERE SITUACAO='CANCELADA'",
					);
					assert.equal(counts.n, 20);
					const [[links]] = await conn.query(
						"SELECT COUNT(*) n FROM propostas_compras",
					);
					assert.equal(links.n, 20);
				},
			);
			await t.test(
				"transferred call can be finalized with frozen UTC to CRM offset",
				async () => {
					await reset();
					const callId = randomUUID();
					await conn.query(
						"INSERT INTO telephony_calls(id,operator_id,direction,number,schedule_id,customer_id,state,prepared_at,sent_at,ended_at,updated_at) VALUES(?,7,'outgoing','51999999999',41,3,'transferred','2026-11-13 12:59:59','2026-11-13 13:00:00','2026-11-13 13:00:00','2026-11-13 13:00:00')",
						[callId],
					);
					const r = await run(input({ callId }));
					assert.ok(r.historyId);
					const [[h]] = await conn.query(
						"SELECT DATAHORA_INICIO FROM historico_cli WHERE CODIGO=?",
						[r.historyId],
					);
					assert.equal(h.DATAHORA_INICIO, "2026-11-13 10:00:00");
				},
			);
			await t.test(
				"configured contact phase is required and stored on exact history row",
				async () => {
					await reset();
					await conn.query(
						"UPDATE parametros SET EXIGIR_FASE_CONTATO='S',EXIBIR_FASE_CONTATO='S'",
					);
					await conn.query(
						"INSERT INTO fase_contato VALUES(1,'Negociacao','S')",
					);
					await assert.rejects(run(input()), /fase/);
					const r = await run(input({ phaseContactId: 1 }));
					const [[h]] = await conn.query(
						"SELECT CODIGO_FASE_CONTATO FROM historico_cli WHERE CODIGO=?",
						[r.historyId],
					);
					assert.equal(h.CODIGO_FASE_CONTATO, 1);
				},
			);
			await t.test(
				"decrement in zero mode releases all remaining pending agendas exactly once",
				async () => {
					await reset();
					await conn.query(
						"UPDATE parametros SET FIDELIZACAO_ZERO='S'",
					);
					await conn.query(
						"UPDATE resultados SET FIDELIZARCOTACAO='NAO'",
					);
					await conn.query(
						"INSERT INTO fidelizacoes(cliente,cc_codigo,cod_origem,qtde_fidelizar,dt_criacao,operador_criacao) VALUES(3,41,0,1,'2026-11-12 10:00:00',7)",
					);
					const command = input();
					const r = await run(command);
					await run(command);
					const [[f]] = await conn.query(
						"SELECT qtde_fidelizar,cod_origem FROM fidelizacoes ORDER BY CODIGO DESC LIMIT 1",
					);
					assert.equal(f.qtde_fidelizar, 0);
					assert.ok(f.cod_origem);
					const [[s]] = await conn.query(
						"SELECT OPERADOR,FIDELIZA FROM campanhas_clientes WHERE CODIGO=?",
						[r.successorScheduleId],
					);
					assert.equal(s.OPERADOR, 0);
					assert.equal(s.FIDELIZA, null);
				},
			);
			await t.test(
				"an already exhausted counter by this actor releases a successor even on a non-contact result",
				async () => {
					await reset();
					await conn.query(
						"UPDATE parametros SET FIDELIZACAO_ZERO='S'",
					);
					await conn.query(
						"UPDATE resultados SET FIDELIZARCOTACAO='NAO',ECONTATO='NAO'",
					);
					await conn.query(
						"INSERT INTO fidelizacoes(cliente,cc_codigo,cod_origem,qtde_fidelizar,dt_criacao,operador_criacao) VALUES(3,41,0,0,'2026-11-12 10:00:00',7)",
					);
					const r = await run(input());
					const [[s]] = await conn.query(
						"SELECT OPERADOR,FIDELIZA FROM campanhas_clientes WHERE CODIGO=?",
						[r.successorScheduleId],
					);
					assert.equal(s.OPERADOR, 0);
					assert.equal(s.FIDELIZA, null);
					const [[f]] = await conn.query(
						"SELECT COUNT(*) n FROM fidelizacoes",
					);
					assert.equal(f.n, 1);
				},
			);
			await t.test(
				"concurrent distinct operations for the same call commit one history and one successor",
				async () => {
					await reset();
					const second = await mysql.createConnection({
						host: "127.0.0.1",
						port,
						user: "root",
						password: "",
						database,
						dateStrings: true,
					});
					try {
						await second.query(
							"SET @inpulse_crm_transfer_at='2026-11-13 10:00:00',@inpulse_crm_utc_at='2026-11-13 13:00:00'",
						);
						const other = {
							tenant: "fixture",
							execute: async (sql, params = []) => {
								const [r] = await second.query(sql, params);
								return r;
							},
						};
						const parallel = async () => {
							await second.beginTransaction();
							try {
								const result = await finishTelephonyV2(
									other,
									input(),
								);
								await second.commit();
								return result;
							} catch (error) {
								await second.rollback();
								throw error;
							}
						};
						const outcomes = await Promise.allSettled([
							run(input()),
							parallel(),
						]);
						assert.equal(
							outcomes.filter((o) => o.status === "fulfilled")
								.length,
							1,
						);
						assert.equal(
							outcomes.filter((o) => o.status === "rejected")
								.length,
							1,
						);
						const [[h]] = await conn.query(
							"SELECT COUNT(*) n FROM historico_cli",
						);
						assert.equal(h.n, 1);
						const [[s]] = await conn.query(
							"SELECT COUNT(*) n FROM campanhas_clientes",
						);
						assert.equal(s.n, 2);
					} finally {
						await second.end();
					}
				},
			);
			await t.test(
				"gate, mandatory sale and foreign owner fail with no writes",
				async () => {
					await reset();
					await conn.query(
						"UPDATE telephony_finish_policy SET enabled=0",
					);
					await assert.rejects(run(input()), /ativação/);
					await conn.query(
						"UPDATE telephony_finish_policy SET enabled=1,sale_enabled=1",
					);
					await conn.query("UPDATE resultados SET EVENDA='SIM'");
					await assert.rejects(run(input()), /venda/);
					await assert.rejects(
						run({ ...input(), actorId: 8 }),
						/atendimento mudou/,
					);
					const [[h]] = await conn.query(
						"SELECT COUNT(*) n FROM historico_cli",
					);
					assert.equal(h.n, 0);
				},
			);
		} finally {
			await conn.query(`DROP DATABASE \`${database}\``);
			await conn.end();
		}
	});
