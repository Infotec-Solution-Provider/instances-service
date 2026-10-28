const test = require("node:test");
const assert = require("node:assert/strict");
const mysql = require("mysql2/promise");
const { TenantDatabase } = require("../dist/tenant-database/tenant-database");
const { tenantDatabaseConfig } = require("../dist/tenant-database/config");
const { createTenantMysqlPool } = require("../dist/tenant-database/mysql-pool");
const { CatalogOrderingService } = require("../dist/catalog-ordering/service");
const { compileOrder } = require("../dist/catalog-ordering/ordering");
const enabled = process.env.RUN_CATALOG_ORDERING_MYSQL === "true";
for (const port of [13328, 13329])
	test(
		`catalog ordering: isolated MySQL ${port}`,
		{ skip: !enabled },
		async (t) => {
			const admin = await mysql.createConnection({
				host: "127.0.0.1",
				port,
				user: "root",
				multipleStatements: false,
			});
			const prefix = `catalog_ordering_${process.pid}_${Date.now()}`;
			const names = { alpha: prefix + "_a", beta: prefix + "_b" };
			const db = new TenantDatabase(
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
				{
					...tenantDatabaseConfig({}),
					transactionMs: 10000,
					activeGlobal: 4,
					activePerServer: 4,
					activePerTenant: 2,
				},
				(destination, connections, timeout) => {
					const pool = createTenantMysqlPool(
						destination,
						connections,
						timeout,
					);
					return {
						end: () => pool.end(),
						acquire: async () => {
							const connection = await pool.acquire();
							await connection.control(
								"SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED",
							);
							return connection;
						},
					};
				},
			);
			const service = new CatalogOrderingService(db);
			const sql = async (statement, params = [], tenant = "alpha") => {
				await admin.query(`USE \`${names[tenant]}\``);
				return (await admin.query(statement, params))[0];
			};
			const read = (kind = "segments", scope) =>
				service.execute("alpha", {
					action: "read",
					kind,
					...(scope ? { scope } : {}),
				});
			const save = (snap, ids, tenant = "alpha") =>
				service.execute(tenant, {
					action: "save",
					kind: snap.kind,
					scope: snap.scope,
					revision: snap.revision,
					ids,
				});
			const code = (expected) => (error) => error.code === expected;
			try {
				for (const name of Object.values(names)) {
					await admin.query(
						`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`,
					);
					await admin.query(`USE \`${name}\``);
					for (const statement of [
						"CREATE TABLE parametros(CODIGO INT PRIMARY KEY,ORDERBY TEXT,SEQUENCIADEORDENACAO VARCHAR(255),ORDENACAO_APENAS_CIDADE CHAR(1)) ENGINE=InnoDB",
						"CREATE TABLE unidades(CODIGO INT PRIMARY KEY) ENGINE=InnoDB",
						"CREATE TABLE segmentos(CODIGO INT PRIMARY KEY AUTO_INCREMENT,NOME VARCHAR(50) UNIQUE,ordem INT,COD_UNIDADE INT) ENGINE=InnoDB",
						"CREATE TABLE uf(UF CHAR(2) PRIMARY KEY,NOME VARCHAR(35),ORDEM INT,FUSOHORARIO INT) ENGINE=InnoDB",
						"CREATE TABLE cidades(CODIGO INT PRIMARY KEY,NOME VARCHAR(40),UF VARCHAR(50),ORDEM INT,ORDEMCIDADE INT,ORDEMESTADO INT) ENGINE=InnoDB",
						"CREATE TABLE campanhas(CODIGO INT PRIMARY KEY,NOME VARCHAR(150),PRIORIDADE INT,PAUSADA VARCHAR(3),UNIDADE INT) ENGINE=InnoDB",
						"INSERT INTO parametros VALUES(1,'opaque legacy SQL','CIDADES,ESTADOS','N')",
						"INSERT INTO unidades VALUES(7)",
						"INSERT INTO segmentos VALUES(1,'Primeiro',8,7),(2,'Segundo',8,NULL),(3,'Zero',0,7),(4,'Nulo',NULL,NULL),(5,'Negativo',-4,7)",
						"INSERT INTO uf VALUES('SP','São Paulo',4,-3),('RJ','Rio de Janeiro',2,-3)",
						"INSERT INTO cidades VALUES(1,'Bom Jardim','SP',5,2,4),(2,'Bom Jardim','RJ',2,1,2),(3,'Órfã',NULL,NULL,NULL,NULL)",
						"INSERT INTO campanhas VALUES(1,'Ativa',3,'NAO',7),(2,'Pausada',0,'SIM',9)",
					])
						await admin.query(statement);
				}
				await t.test(
					"effective order, ties and unprioritized rows; normalization preserves other fields",
					async () => {
						const before = await sql(
							"SELECT CODIGO,NOME,COD_UNIDADE FROM segmentos ORDER BY CODIGO",
						);
						const snap = await read();
						assert.deepEqual(
							snap.items.map((item) => item.id),
							[1, 2, 5, 4, 3],
						);
						const result = await save(snap, [5, 3, 1, 4, 2]);
						assert.deepEqual(
							result.items.map((item) => item.storedOrder),
							[1, 2, 3, 4, 5],
						);
						assert.deepEqual(
							await sql(
								"SELECT CODIGO,NOME,COD_UNIDADE FROM segmentos ORDER BY CODIGO",
							),
							before,
						);
					},
				);
				await t.test(
					"reject duplicate, missing, unknown and cross-tenant IDs/revisions",
					async () => {
						const snap = await read();
						await assert.rejects(
							save(snap, [1, 1, 3, 4, 5]),
							code("TENANT_ORDERING_INVALID"),
						);
						await assert.rejects(
							save(snap, [1, 2]),
							code("TENANT_ORDERING_CHANGED"),
						);
						await assert.rejects(
							save(snap, [1, 2, 3, 4, 99]),
							code("TENANT_ORDERING_CHANGED"),
						);
						await assert.rejects(
							save(snap, [1, 2, 3, 4, 5], "beta"),
							code("TENANT_ORDERING_CHANGED"),
						);
						await assert.rejects(
							service.execute("alpha", {
								action: "save",
								kind: "segments",
								scope: "all",
								ids: [1, 2, 3, 4, 5],
								revision: snap.revision,
								sql: "DELETE FROM segmentos",
							}),
							code("TENANT_ORDERING_INVALID"),
						);
					},
				);
				await t.test(
					"rename/insertion/deletion invalidates the snapshot",
					async () => {
						let snap = await read();
						await sql(
							"UPDATE segmentos SET NOME='Renomeado' WHERE CODIGO=1",
						);
						await assert.rejects(
							save(
								snap,
								snap.items.map((i) => i.id),
							),
							code("TENANT_ORDERING_CHANGED"),
						);
						snap = await read();
						await service.execute("alpha", {
							action: "create",
							kind: "segments",
							fields: { NOME: "Novo", COD_UNIDADE: 7 },
						});
						await assert.rejects(
							save(
								snap,
								snap.items.map((i) => i.id),
							),
							code("TENANT_ORDERING_CHANGED"),
						);
						snap = await read();
						await sql("DELETE FROM segmentos WHERE NOME='Novo'");
						await assert.rejects(
							save(
								snap,
								snap.items.map((i) => i.id),
							),
							code("TENANT_ORDERING_CHANGED"),
						);
					},
				);
				await t.test(
					"simultaneous reorder has one winner; simultaneous inserts append without ties",
					async () => {
						const snap = await read(),
							ids = snap.items.map((i) => i.id);
						const results = await Promise.allSettled([
							save(snap, [...ids].reverse()),
							save(snap, [...ids].slice(1).concat(ids[0])),
						]);
						assert.equal(
							results.filter((r) => r.status === "fulfilled")
								.length,
							1,
						);
						const created = await Promise.all(
							["Concorrente A", "Concorrente B"].map((NOME) =>
								service.execute("alpha", {
									action: "create",
									kind: "segments",
									fields: { NOME },
								}),
							),
						);
						assert.notEqual(created[0].id, created[1].id);
						const rows = await sql(
							"SELECT ordem FROM segmentos WHERE NOME LIKE 'Concorrente%' ORDER BY ordem",
						);
						assert.deepEqual(
							rows.map((r) => r.ordem),
							[6, 7],
						);
					},
				);
				await t.test(
					"city national and UF lists preserve each other; state order preserves timezone",
					async () => {
						const country = await read("cities", "national");
						assert.equal(country.invalidUfCount, 1);
						assert.equal(country.items[2].validUf, false);
						await save(country, [3, 1, 2]);
						const sp = await read("cities", "SP");
						assert.deepEqual(
							sp.items.map((i) => i.id),
							[1],
						);
						await save(sp, [1]);
						assert.deepEqual(
							(await read("cities", "national")).items.map(
								(i) => i.id,
							),
							[3, 1, 2],
						);
						const states = await read("states");
						await save(states, ["SP", "RJ"]);
						assert.deepEqual(
							(
								await sql(
									"SELECT ORDEMESTADO FROM cidades ORDER BY CODIGO",
								)
							).map((r) => r.ORDEMESTADO),
							[1, 2, null],
						);
						assert.deepEqual(
							(await sql("SELECT FUSOHORARIO FROM uf")).map(
								(r) => r.FUSOHORARIO,
							),
							[-3, -3],
						);
						await assert.rejects(
							read("cities", "XX"),
							code("TENANT_ORDERING_SCOPE_UNAVAILABLE"),
						);
						const inserted = await service.execute("alpha", {
							action: "create",
							kind: "cities",
							fields: { CODIGO: 4, NOME: "Nova", UF: "SP" },
						});
						assert.equal(inserted.id, 4);
						assert.deepEqual(
							await sql(
								"SELECT ORDEM,ORDEMCIDADE,ORDEMESTADO FROM cidades WHERE CODIGO=4",
							),
							[{ ORDEM: 2, ORDEMCIDADE: 4, ORDEMESTADO: 1 }],
						);
					},
				);
				await t.test(
					"paused campaigns included; append creates all four kinds",
					async () => {
						const snap = await read("campaigns");
						assert.equal(snap.items[0].paused, true);
						await save(snap, [1, 2]);
						await service.execute("alpha", {
							action: "create",
							kind: "campaigns",
							fields: {
								CODIGO: 3,
								NOME: "Nova campanha",
								PAUSADA: "SIM",
								UNIDADE: 7,
							},
						});
						assert.equal(
							(
								await sql(
									"SELECT PRIORIDADE FROM campanhas WHERE CODIGO=3",
								)
							)[0].PRIORIDADE,
							3,
						);
						await service.execute("alpha", {
							action: "create",
							kind: "states",
							fields: {
								UF: "MG",
								NOME: "Minas Gerais",
								FUSOHORARIO: 0,
							},
						});
						assert.equal(
							(await sql("SELECT ORDEM FROM uf WHERE UF='MG'"))[0]
								.ORDEM,
							3,
						);
					},
				);
				await t.test(
					"criteria mode and SQL commit together; homonymous cities use UF",
					async () => {
						const expected = (
							await sql("SELECT * FROM parametros")
						)[0];
						const result = await service.execute("alpha", {
							action: "criteria",
							criteria: ["ESTADOS", "CIDADES", "SEGMENTOS"],
							cityMode: "S",
							expected,
						});
						assert.equal(result.data.ORDENACAO_APENAS_CIDADE, "S");
						assert.equal(
							result.data.ORDERBY,
							compileOrder(
								["ESTADOS", "CIDADES", "SEGMENTOS"],
								"S",
							),
						);
						assert.equal(
							(result.data.ORDERBY.match(/ORDEMCIDADE/g) || [])
								.length,
							1,
						);
						assert.match(result.data.ORDERBY, /ct.UF=c_.ESTADO/);
						await assert.rejects(
							service.execute("alpha", {
								action: "criteria",
								criteria: ["CIDADES"],
								cityMode: "N",
								expected,
							}),
							code("TENANT_ORDERING_CHANGED"),
						);
						await sql(
							"CREATE TABLE clientes(CODIGO INT PRIMARY KEY,CIDADE VARCHAR(40),ESTADO CHAR(2)) ENGINE=InnoDB",
						);
						await sql(
							"INSERT INTO clientes VALUES(1,'Bom Jardim','SP'),(2,'Bom Jardim','RJ')",
						);
						assert.deepEqual(
							(
								await sql(
									`SELECT c_.CODIGO FROM clientes c_ ORDER BY ${compileOrder(["CIDADES"], "N").replace(",cc.CODIGO ASC", "")}`,
								)
							).map((r) => r.CODIGO),
							[1, 2],
						);
					},
				);
				await t.test(
					"multi-batch failure rolls back the whole list",
					async () => {
						const fields = Array.from({ length: 501 }, (_, i) => [
							1000 + i,
							`Bulk ${i}`,
							1000 + i,
							null,
						]);
						await sql(
							"INSERT INTO segmentos(CODIGO,NOME,ordem,COD_UNIDADE) VALUES ?",
							[fields],
						);
						const before = await sql(
								"SELECT CODIGO,ordem FROM segmentos ORDER BY CODIGO",
							),
							snap = await read();
						let updates = 0;
						const failing = new CatalogOrderingService({
							transaction: (tenant, operation, tables, work) =>
								db.transaction(
									tenant,
									operation,
									tables,
									(tx) =>
										work({
											tenant,
											execute: async (
												statement,
												params,
											) => {
												if (
													statement.startsWith(
														"UPDATE `segmentos`",
													) &&
													++updates === 2
												)
													throw Error(
														"simulated batch failure",
													);
												return tx.execute(
													statement,
													params,
												);
											},
										}),
								),
						});
						await assert.rejects(
							failing.execute("alpha", {
								action: "save",
								kind: "segments",
								scope: "all",
								revision: snap.revision,
								ids: snap.items.map((i) => i.id).reverse(),
							}),
						);
						assert.deepEqual(
							await sql(
								"SELECT CODIGO,ordem FROM segmentos ORDER BY CODIGO",
							),
							before,
						);
					},
				);
				await t.test(
					"empty lists, unreviewed triggers and incompatible engine fail safely",
					async () => {
						await sql("DELETE FROM campanhas");
						const empty = await read("campaigns");
						assert.deepEqual((await save(empty, [])).items, []);
						await sql(
							"CREATE TRIGGER reject_ordering BEFORE UPDATE ON segmentos FOR EACH ROW SET NEW.NOME=NEW.NOME",
						);
						await assert.rejects(
							read(),
							code("TENANT_TRANSACTION_UNREVIEWED_TRIGGERS"),
						);
						await sql("DROP TRIGGER reject_ordering");
						await sql("ALTER TABLE campanhas ENGINE=MyISAM");
						await assert.rejects(
							read("campaigns"),
							code("TENANT_TRANSACTION_REQUIRES_INNODB"),
						);
					},
				);
			} finally {
				await db.close();
				for (const name of Object.values(names))
					await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
				await admin.end();
			}
		},
	);
