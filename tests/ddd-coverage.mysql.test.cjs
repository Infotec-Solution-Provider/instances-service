const test = require("node:test"), assert = require("node:assert/strict");
const mysql = require("mysql2/promise");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { TenantDatabase } = require("../dist/tenant-database/tenant-database");
const { tenantDatabaseConfig } = require("../dist/tenant-database/config");
const { CatalogOrderingService } = require("../dist/catalog-ordering/service");
// Explicit opt-in, fixed loopback only; never consumes production or tenant credentials.
test("DDD coverage migration and invariants on a fresh isolated local MySQL database", { skip: process.env.RUN_DDD_COVERAGE_MYSQL !== "true" }, async () => {
  const port = Number(process.env.DDD_COVERAGE_MYSQL_PORT || "13328");
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
  const name = `ddd_coverage_${process.pid}_${Date.now()}`;
  const admin = await mysql.createConnection({ host: "127.0.0.1", port, user: "root", multipleStatements: false });
  const db = new TenantDatabase(async tenant => tenant === "synthetic" ? { tenant, host: "127.0.0.1", port, user: "root", password: "", database: name } : null, { ...tenantDatabaseConfig({}), transactionMs: 10000 });
  const service = new CatalogOrderingService(db);
  const input = { action: "phone-area-associate", ddd: "11", uf: "SP", actorId: 7, links: [{ cityId: 1, expectedName: "São Paulo", providerCity: "SÃO PAULO" }] };
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`); created = true;
    await admin.query(`USE \`${name}\``);
    for (const sql of ["CREATE TABLE fone_areas(CODIGO VARCHAR(5) PRIMARY KEY,DESCRICAO VARCHAR(20)) ENGINE=InnoDB", "CREATE TABLE cidades(CODIGO INT PRIMARY KEY,NOME VARCHAR(40),UF VARCHAR(50)) ENGINE=InnoDB", "CREATE TABLE cidades_ddd(cidade INT) ENGINE=InnoDB", "INSERT INTO fone_areas VALUES('11','Original')", "INSERT INTO cidades VALUES(1,'São Paulo','SP')", "INSERT INTO cidades_ddd VALUES(99)"]) await admin.query(sql);
    const migration = readFileSync(join(__dirname, "../docs/migrations/20261103-ddd-coverage.sql"), "utf8").replace(/^--.*$/gm, "").trim();
    await admin.query(migration);
    assert.deepEqual(await service.execute("synthetic", input), { added: 1, existing: 0 });
    assert.deepEqual(await service.execute("synthetic", input), { added: 0, existing: 1 });
    assert.deepEqual((await admin.query("SELECT cidade FROM cidades_ddd"))[0].map(row => row.cidade), [99]);
    assert.deepEqual((await admin.query("SELECT city_id,created_by FROM crm_ddd_city_links"))[0].map(row => [row.city_id,row.created_by]), [[1,7]]);
    const stale = { action: "phone-area-patch", fields: { CODIGO: "11", DESCRICAO: "First" }, expected: { DESCRICAO: "Original" } };
    const results = await Promise.allSettled([service.execute("synthetic", stale), service.execute("synthetic", { ...stale, fields: { ...stale.fields, DESCRICAO: "Second" } })]);
    assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
    assert.equal(results.find(row => row.status === "rejected").reason.code, "TENANT_ORDERING_CHANGED");
    await admin.query("UPDATE cidades SET NOME='Renamed' WHERE CODIGO=1");
    await assert.rejects(service.execute("synthetic", input), { code: "TENANT_ORDERING_CHANGED" });
    assert.equal((await admin.query("SELECT COUNT(*) AS n FROM crm_ddd_city_links"))[0][0].n, 1);
  } finally {
    await db.close();
    if (created) await admin.query(`DROP DATABASE \`${name}\``);
    await admin.end();
  }
});
