const { test } = require("node:test");
const assert = require("node:assert/strict");
const mysql = require("mysql2/promise");
const { TenantDatabase } = require("../dist/tenant-database/tenant-database");
const { tenantDatabaseConfig } = require("../dist/tenant-database/config");
const { CrmUnitsService } = require("../dist/crm-units/service");
const fs = require("node:fs");
const path = require("node:path");

// Opt-in only: local disposable schemas, never a tenant registry or environment credentials.
for (const port of require("./isolated-mysql-ports.cjs")(
	"CRM_UNITS_MYSQL_PORTS",
	[13328, 13329],
)) {
	test(
		`CRM units on isolated MySQL ${port}`,
		{ skip: process.env.RUN_CRM_UNITS_MYSQL !== "true" },
		async () => {
			const admin = await mysql.createConnection({
				host: "127.0.0.1",
				port,
				user: "root",
			});
			const prefix = `crm_units_${process.pid}_${Date.now()}`;
			const names = { alpha: prefix + "_a", beta: prefix + "_b" },
				created = [];
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
				{ ...tenantDatabaseConfig({}), transactionMs: 10000 },
			);
			const service = new CrmUnitsService(database);
			const run = (tenant, command, body = {}) =>
				service.execute(tenant, { action: "units", command, ...body });
			const fields = {
				CODIGO: 2,
				DESCRICAO: "São José",
				INATIVOS_RECENTES: 30,
				INATIVOS_ANTIGOS: 90,
			};
			const campaign = {
				CODIGO: 11,
				NOME: "São José - PROSPE",
				TIPO: "PROSPE",
				MAX_RESPOSTA: 300,
				PAUSADA: "SIM",
			};
			try {
				for (const name of Object.values(names)) {
					assert.match(name, /^crm_units_\d+_\d+_[ab]$/);
					await admin.query(
						`CREATE DATABASE \`${name}\` CHARACTER SET latin1 COLLATE latin1_swedish_ci`,
					);
					created.push(name);
					await admin.query(`USE \`${name}\``);
					await admin.query(
						"CREATE TABLE parametros(CODIGO INT PRIMARY KEY) ENGINE=InnoDB",
					);
					await admin.query("INSERT INTO parametros VALUES(1)");
					await admin.query(
						"CREATE TABLE unidades(CODIGO INT PRIMARY KEY,DESCRICAO VARCHAR(50),INATIVOS_RECENTES INT,INATIVOS_ANTIGOS INT) ENGINE=InnoDB",
					);
					await admin.query(
						"INSERT INTO unidades VALUES(1,'Legada',90,180)",
					);
					await admin.query(
						"CREATE TABLE campanhas(CODIGO INT PRIMARY KEY,NOME VARCHAR(150) UNIQUE,DATA_INI DATETIME NULL,MAX_RESPOSTA INT,DESCRICAO TEXT,PRIORIDADE INT,SQL_CAMPANHA TEXT,GERADO_LISTA ENUM('SIM','NAO'),PAUSADA ENUM('SIM','NAO'),PAUSAR_AG_PUBLICA ENUM('SIM','NAO'),TIPO ENUM('ATIVOS','INAT_R','INAT_A','PROSPE'),UNIDADE INT,OPERADOR INT) ENGINE=InnoDB",
					);
					await admin.query(
						fs.readFileSync(
							path.join(
								__dirname,
								"../migrations/20261103-crm-campaign-policies.sql",
							),
							"utf8",
						),
					);
					await admin.query(
						"CREATE TABLE operadores(CODIGO INT PRIMARY KEY,ATIVO ENUM('SIM','NAO')) ENGINE=InnoDB",
					);
					await admin.query(
						"INSERT INTO operadores VALUES(1,'SIM'),(2,'SIM'),(3,'NAO')",
					);
					await admin.query(
						"CREATE TABLE campanhasxoperadores(CODIGO INT PRIMARY KEY DEFAULT 0,CAMPANHA INT,OPERADOR INT) ENGINE=InnoDB",
					);
				}
				await run("alpha", "create", { fields, campaigns: [campaign] });
				const detail = await run("alpha", "detail", { id: 2 });
				assert.equal(detail.campaigns.length, 1);
				assert.equal(detail.campaigns[0].PAUSADA, "SIM");
				assert.equal((await run("beta", "list")).data.length, 1);
				const { CODIGO, ...expected } = detail.campaigns[0];
				await assert.rejects(
					run("alpha", "campaign-patch", {
						id: CODIGO,
						changes: { PAUSADA: "NAO" },
						expected,
					}),
					{ code: "TENANT_ORDERING_COMPOSITION_PENDING" },
				);
				await assert.rejects(
					run("alpha", "campaign-patch", {
						id: CODIGO,
						changes: { NOME: "Público com nome próprio" },
						expected,
					}),
					{ code: "TENANT_ORDERING_LEGACY_NAME_DEPENDENCY" },
				);
				await run("alpha", "campaign-patch", {
					id: CODIGO,
					changes: { MAX_RESPOSTA: 60 },
					expected,
				});
				await assert.rejects(
					run("alpha", "campaign-patch", {
						id: CODIGO,
						changes: { NOME: "Snapshot antigo" },
						expected,
					}),
					{ code: "TENANT_ORDERING_CHANGED" },
				);
				const concurrent = await Promise.allSettled(
					[12, 13].map((id) =>
						run("alpha", "campaign-create", {
							fields: {
								...campaign,
								CODIGO: id,
								NOME: "São José - ATIVOS",
								TIPO: "ATIVOS",
								UNIDADE: 2,
							},
						}),
					),
				);
				assert.equal(
					concurrent.filter((r) => r.status === "fulfilled").length,
					1,
				);
				assert.equal(
					(await run("alpha", "detail", { id: 2 })).campaigns.length,
					2,
				);
				// Invalid legacy names never enter a transaction's INSERT phase.
				await assert.rejects(
					run("alpha", "create", {
						fields: { ...fields, CODIGO: 3, DESCRICAO: "Rollback" },
						campaigns: [
							{
								...campaign,
								CODIGO: 20,
								NOME: "Duplicado",
								TIPO: "ATIVOS",
							},
							{
								...campaign,
								CODIGO: 21,
								NOME: "Duplicado",
								TIPO: "PROSPE",
							},
						],
					}),
				);
				assert.equal(
					(await run("alpha", "list")).data.some(
						(u) => u.CODIGO === 3,
					),
					false,
				);
				await admin.query(`USE \`${names.alpha}\``);
				const [rows] = await admin.query(
					"SELECT CODIGO FROM campanhas WHERE CODIGO IN (20,21)",
				);
				assert.equal(rows.length, 0);
				await assert.rejects(
					run("alpha", "patch", {
						id: 2,
						changes: { DESCRICAO: "Unidade renomeada" },
						expected: fields,
					}),
					{ code: "TENANT_ORDERING_LEGACY_NAME_DEPENDENCY" },
				);
				assert.equal(
					(await run("alpha", "detail", { id: 2 })).campaigns.length,
					2,
				);
				const shortUnits = await Promise.all(
					["Manual A", "Manual B"].map((DESCRICAO) =>
						run("alpha", "create", {
							fields: {
								DESCRICAO,
								INATIVOS_RECENTES: 30,
								INATIVOS_ANTIGOS: 90,
							},
						}),
					),
				);
				assert.equal(new Set(shortUnits.map((u) => u.CODIGO)).size, 2);
				const extra = await Promise.all(
					Array.from({ length: 6 }, (_, i) =>
						run("alpha", "campaign-create", {
							operationMode: "audience-manual",
							organizationalUnitId: shortUnits[0].CODIGO,
							fields: {
								NOME: `Público livre ${i}`,
								MAX_RESPOSTA: 0,
							},
						}),
					),
				);
				assert.equal(new Set(extra.map((c) => c.CODIGO)).size, 6);
				const manual = await run("alpha", "detail", {
					id: shortUnits[0].CODIGO,
				});
				assert.equal(manual.data.manualCampaignCount, 6);
				assert.equal(manual.campaigns.length, 6);
				assert(
					manual.campaigns.every(
						(c) => c.UNIDADE === null && c.TIPO === null,
					),
				);
				const context = await run("alpha", "campaign-context", {
					id: extra[0].CODIGO,
				});
				assert.equal(context.capabilities.resume.allowed, true);
				const { CODIGO: manualId, ...manualExpected } =
					context.campaign;
				await run("alpha", "campaign-patch", {
					id: manualId,
					changes: { PAUSADA: "NAO" },
					expected: manualExpected,
				});
				assert.equal(
					(await run("alpha", "campaign-context", { id: manualId }))
						.campaign.PAUSADA,
					"NAO",
				);
				assert.equal((await run("beta", "list")).data.length, 1);
				const members = await Promise.all(
					[1, 2].map((OPERADOR) =>
						run("alpha", "member-create", {
							id: manualId,
							fields: { OPERADOR },
						}),
					),
				);
				assert.equal(new Set(members.map((m) => m.CODIGO)).size, 2);
				await assert.rejects(
					run("alpha", "member-create", {
						id: manualId,
						fields: { OPERADOR: 1 },
					}),
					{ code: "TENANT_DUPLICATE_KEY" },
				);
				await assert.rejects(
					run("alpha", "member-create", {
						id: manualId,
						fields: { OPERADOR: 3 },
					}),
					{ code: "TENANT_ORDERING_UNIT_UNAVAILABLE" },
				);
			} finally {
				await database.close();
				for (const name of created)
					await admin.query(`DROP DATABASE \`${name}\``);
				await admin.end();
			}
		},
	);
}
