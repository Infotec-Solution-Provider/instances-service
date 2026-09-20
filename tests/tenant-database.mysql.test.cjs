const assert = require("node:assert/strict");
const test = require("node:test");
const mysql = require("mysql2/promise");
const {
	TenantDatabase,
} = require("../dist/tenant-database/tenant-database.js");
const { tenantDatabaseConfig } = require("../dist/tenant-database/config.js");
const {
	createTenantMysqlPool,
} = require("../dist/tenant-database/mysql-pool.js");

const enabled = process.env.RUN_TENANT_MYSQL_TESTS === "true";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

for (const [version, port] of [
	["8.0", 13318],
	["5.5", 13355],
]) {
	test(
		`MySQL ${version}: tenant transactions, Unicode, isolation, contention and ambiguous commit`,
		{ skip: !enabled },
		async (t) => {
			const admin = await mysql.createConnection({
				host: "127.0.0.1",
				port,
				user: "root",
				charset: "utf8mb4_unicode_ci",
			});
			const prefix = `tenant_foundation_${process.pid}_${Date.now()}`;
			const names = { alpha: `${prefix}_a`, beta: `${prefix}_b` };
			const services = [];
			const config = {
				...tenantDatabaseConfig({}),
				waitMs: 2000,
				transactionMs: 3000,
				activeGlobal: 3,
				activePerServer: 3,
			};
			const resolver = async (tenant) =>
				names[tenant]
					? {
							tenant,
							host: "127.0.0.1",
							port,
							user: "root",
							password: "",
							database: names[tenant],
						}
					: null;
			const factory = (destination, limit, timeout) => {
				const pool = createTenantMysqlPool(destination, limit, timeout);
				return {
					end: () => pool.end(),
					async acquire() {
						const connection = await pool.acquire();
						await connection.control(
							"SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES'",
						);
						return connection;
					},
				};
			};
			const create = (overrides = {}, poolFactory = factory) => {
				const db = new TenantDatabase(
					resolver,
					{ ...config, ...overrides },
					poolFactory,
				);
				services.push(db);
				return db;
			};
			try {
				for (const name of Object.values(names)) {
					await admin.query(
						`CREATE DATABASE \`${name}\` DEFAULT CHARACTER SET latin1 COLLATE latin1_swedish_ci`,
					);
					await admin.query(
						`CREATE TABLE \`${name}\`.messages (id INT PRIMARY KEY, body LONGTEXT NULL, large_id BIGINT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
					);
					await admin.query(
						`CREATE TABLE \`${name}\`.outbox (id INT PRIMARY KEY) ENGINE=InnoDB`,
					);
				}
				const db = create();
				await t.test(
					"same IDs in different tenants, prepared Unicode parameters and one session",
					async () => {
						const samples = [
							null,
							"",
							"Ação 👩🏽‍💻 中文",
							"%20 literal https://x/a%20b",
							"line\n'\"\\",
							"e\u0301",
						];
						for (const tenant of ["alpha", "beta"]) {
							await db.transaction(
								tenant,
								"messages.insert",
								["messages", "outbox"],
								async (tx) => {
									const [before] = await tx.execute(
										"SELECT DATABASE() AS db, CONNECTION_ID() AS id, @@character_set_connection AS charset, @@sql_mode AS mode",
									);
									assert.equal(before.db, names[tenant]);
									assert.equal(before.charset, "utf8mb4");
									assert.match(
										before.mode,
										/STRICT_ALL_TABLES/,
									);
									assert.match(
										before.mode,
										/NO_BACKSLASH_ESCAPES/,
									);
									for (let i = 0; i < samples.length; i++)
										await tx.execute(
											"INSERT INTO messages (id, body, large_id) VALUES (?, ?, ?)",
											[
												i + 1,
												tenant === "alpha"
													? samples[i]
													: "beta",
												"9007199254740993",
											],
										);
									await tx.execute(
										"INSERT INTO outbox (id) VALUES (?)",
										[1],
									);
									const [after] = await tx.execute(
										"SELECT CONNECTION_ID() AS id",
									);
									assert.equal(after.id, before.id);
								},
							);
						}
						const rows = await db.transaction(
							"alpha",
							"messages.read",
							["messages"],
							(tx) =>
								tx.execute(
									"SELECT body, HEX(body) AS bytes, large_id FROM messages ORDER BY id LIMIT 10",
								),
						);
						assert.deepEqual(
							rows.map((row) => row.body),
							samples,
						);
						assert.deepEqual(
							rows.map((row) => row.bytes),
							samples.map((value) =>
								value === null
									? null
									: Buffer.from(value)
											.toString("hex")
											.toUpperCase(),
							),
						);
						assert.ok(
							rows.every(
								(row) => row.large_id === "9007199254740993",
							),
						);
					},
				);
				await t.test(
					"second write fails: first write rolls back, including a swallowed SQL error",
					async () => {
						await assert.rejects(
							db.transaction(
								"alpha",
								"messages.insert",
								["messages", "outbox"],
								async (tx) => {
									await tx.execute(
										"INSERT INTO messages (id, body) VALUES (?, ?)",
										[10, "must rollback"],
									);
									await tx
										.execute(
											"INSERT INTO outbox (id) VALUES (?)",
											[1],
										)
										.catch(() => {});
								},
							),
							{
								code: "TENANT_TRANSACTION_QUERY_FAILED",
								outcome: "NOT_COMMITTED",
							},
						);
						const [rows] = await admin.query(
							`SELECT id FROM \`${names.alpha}\`.messages WHERE id = 10`,
						);
						assert.equal(rows.length, 0);
					},
				);
				await t.test(
					"COMMIT applies but acknowledgement is lost: UNKNOWN and exactly one execution",
					async () => {
						let commits = 0,
							callbacks = 0;
						const ambiguous = create(
							{},
							(destination, limit, timeout) => {
								const pool = factory(
									destination,
									limit,
									timeout,
								);
								return {
									end: () => pool.end(),
									async acquire() {
										const connection = await pool.acquire();
										return {
											...connection,
											async control(sql) {
												await connection.control(sql);
												if (sql === "COMMIT") {
													commits++;
													throw new Error(
														"injected lost acknowledgement",
													);
												}
											},
										};
									},
								};
							},
						);
						await assert.rejects(
							ambiguous.transaction(
								"alpha",
								"messages.insert",
								["messages"],
								async (tx) => {
									callbacks++;
									await tx.execute(
										"INSERT INTO messages (id, body) VALUES (?, ?)",
										[20, "persisted once"],
									);
								},
							),
							{
								code: "TENANT_COMMIT_UNKNOWN",
								outcome: "UNKNOWN",
							},
						);
						const [rows] = await admin.query(
							`SELECT body FROM \`${names.alpha}\`.messages WHERE id = 20`,
						);
						assert.equal(rows[0].body, "persisted once");
						assert.equal(commits, 1);
						assert.equal(callbacks, 1);
					},
				);
				await t.test(
					"query deadline destroys session; uncommitted writes stay absent",
					async () => {
						const short = create({ transactionMs: 100 });
						await assert.rejects(
							short.transaction(
								"alpha",
								"messages.insert",
								["messages"],
								async (tx) => {
									await tx.execute(
										"INSERT INTO messages (id, body) VALUES (?, ?)",
										[30, "never committed"],
									);
									await tx.execute("SELECT SLEEP(0.3)");
								},
							),
							{
								code: "TENANT_TRANSACTION_TIMEOUT",
								outcome: "NOT_COMMITTED",
							},
						);
						await pause(400);
						const [rows] = await admin.query(
							`SELECT id FROM \`${names.alpha}\`.messages WHERE id = 30`,
						);
						assert.equal(rows.length, 0);
					},
				);
				await t.test(
					"parallel workloads obey per-tenant and shared-server limits",
					async () => {
						let active = 0,
							peak = 0;
						const byTenant = { alpha: 0, beta: 0 };
						await Promise.all(
							Array.from({ length: 16 }, (_, i) => {
								const tenant = i % 2 ? "alpha" : "beta";
								return db.transaction(
									tenant,
									"messages.read",
									["messages"],
									async (tx) => {
										active++;
										byTenant[tenant]++;
										peak = Math.max(peak, active);
										try {
											assert.ok(active <= 3);
											assert.ok(byTenant[tenant] <= 2);
											await tx.execute(
												"SELECT SLEEP(0.02)",
											);
										} finally {
											active--;
											byTenant[tenant]--;
										}
									},
								);
							}),
						);
						assert.ok(peak >= 2);
						assert.equal(db.snapshot().pending, 0);
					},
				);
				await t.test(
					"metadata lock prevents engine change mid-transaction; MyISAM blocks later use",
					async () => {
						await admin.query(
							`CREATE TABLE \`${names.alpha}\`.lock_probe (id INT PRIMARY KEY) ENGINE=InnoDB`,
						);
						const entered = deferred(),
							resume = deferred();
						const holding = db.transaction(
							"alpha",
							"probe.read",
							["lock_probe"],
							async () => {
								entered.resolve();
								await resume.promise;
							},
						);
						await entered.promise;
						let changed = false;
						const alteration = admin
							.query(
								`ALTER TABLE \`${names.alpha}\`.lock_probe ENGINE=MyISAM`,
							)
							.then(() => {
								changed = true;
							});
						await pause(40);
						assert.equal(changed, false);
						resume.resolve();
						await holding;
						await alteration;
						await assert.rejects(
							db.transaction(
								"alpha",
								"probe.read",
								["lock_probe"],
								async () =>
									assert.fail("nontransactional callback"),
							),
							{ code: "TENANT_TRANSACTION_REQUIRES_INNODB" },
						);
					},
				);
			} finally {
				await Promise.all(services.map((service) => service.close()));
				for (const name of Object.values(names))
					await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
				await admin.end();
			}
		},
	);
}
