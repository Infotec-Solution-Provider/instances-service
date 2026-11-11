const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// Explicit local-only fixture. Never discovers credentials from application .env files.
const fixtureUrl = process.env.ADMIN_MYSQL_TEST_URL;
test("administration CRM and registry use real MySQL atomic receipts and stale-revision protection", { skip: !fixtureUrl }, async () => {
  const url = new URL(fixtureUrl);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "fixture must be local");
  const mysql = require("mysql2/promise");
  const registryName = "infotec_admin_backend_test_instances", crmName = "infotec_admin_backend_test_crm", nextName = "infotec_admin_backend_test_crm_next";
  const options = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const connection = await mysql.createConnection(options);
  const tenant = "backend-test-tenant";
  const safeName = name => { assert.match(name, /^infotec_admin_backend_test_[a-z_]+$/); return `\`${name}\``; };
  await connection.query(`CREATE DATABASE IF NOT EXISTS ${safeName(registryName)}`);
  await connection.query(`CREATE DATABASE IF NOT EXISTS ${safeName(crmName)}`);
  await connection.query(`CREATE DATABASE IF NOT EXISTS ${safeName(nextName)}`);
  process.env.INSTANCES_DATABASE_URL = `mysql://${encodeURIComponent(options.user)}:${encodeURIComponent(options.password)}@${options.host}:${options.port}/${registryName}`;
  process.env.ADMIN_REVISION_KEY = "fixture-only-revision-key-at-least-32-characters";
  const receiptDdl = await fs.readFile(path.join(__dirname, "../migrations/20261111-admin-operation-receipts.sql"), "utf8");
  for (const database of [registryName, crmName, nextName]) {
    await connection.query(`USE ${safeName(database)}`);
    await connection.query(receiptDdl);
    await connection.query("DELETE FROM admin_operation_receipts");
  }
  await connection.query(`USE ${safeName(registryName)}`);
  await connection.query(await fs.readFile(path.join(__dirname, "../migrations/20261111-admin-saved-configurations.sql"), "utf8"));
  await connection.query("DELETE FROM admin_saved_configurations");
  await connection.query("CREATE TABLE IF NOT EXISTS clients (name VARCHAR(100) PRIMARY KEY) ENGINE=InnoDB");
  await connection.query("CREATE TABLE IF NOT EXISTS clients_servers (instance_name VARCHAR(100) PRIMARY KEY,host VARCHAR(255) NOT NULL,port INT NOT NULL,username VARCHAR(255) NOT NULL,password VARCHAR(255) NOT NULL,`database` VARCHAR(255) NOT NULL) ENGINE=InnoDB");
  await connection.query("CREATE TABLE IF NOT EXISTS clients_parameters (instance_name VARCHAR(100) PRIMARY KEY,parameters JSON NOT NULL) ENGINE=InnoDB");
  await connection.query("REPLACE INTO clients (name) VALUES (?)", [tenant]);
  await connection.query("REPLACE INTO clients_servers (instance_name,host,port,username,password,`database`) VALUES (?,?,?,?,?,?)", [tenant, options.host, options.port, options.user, options.password, crmName]);
  await connection.query("REPLACE INTO clients_parameters (instance_name,parameters) VALUES (?,?)", [tenant, JSON.stringify({ flag: false, privateToken: "fixture-old-private" })]);
  await connection.query(`USE ${safeName(crmName)}`);
  await connection.query("CREATE TABLE IF NOT EXISTS parametros (CODIGO INT PRIMARY KEY,FLAG ENUM('S','N') NOT NULL DEFAULT 'N',SENHA VARCHAR(100) NULL) ENGINE=InnoDB");
  await connection.query("REPLACE INTO parametros (CODIGO,FLAG,SENHA) VALUES (1,'S','fixture-old-private')");
  await connection.query(`CREATE TABLE IF NOT EXISTS ${safeName(nextName)}.parametros LIKE parametros`);
  const { crmSettings } = require("../dist/admin/crm-settings");
  const { instanceSettings } = require("../dist/admin/instance-settings");
  const { withAdminActor } = require("../dist/admin/settings-utils");
  const { prisma } = require("../dist/services/prisma.service");
  const pools = require("../dist/services/pools.service").default;
  const { closeTenantDatabase, getTenantDatabase } = require("../dist/services/tenant-database.service");
  const actor = { instance: "infotec", userId: 7, role: "ADMIN", name: "Fixture" };
  const run = (handler, command) => withAdminActor(actor, () => handler(command));
  const base = { action: "getSettings", source: "crm", tenant, environment: "homolog" };
  try {
    const current = await run(crmSettings, base);
    assert.equal(current.values.FLAG, "S"); assert.equal(current.values.SENHA, undefined); assert.equal(current.secrets.SENHA.configured, true);
    const command = { ...base, action: "saveSettings", operationId: randomUUID(), revision: current.revision, changes: [{ key: "FLAG", action: "set", value: "N" }, { key: "SENHA", action: "set", value: "fixture-new-private" }] };
    const result = await run(crmSettings, command);
    assert.equal(result.state, "COMMITTED"); assert.ok(!JSON.stringify(result).includes("fixture-new-private"));
    assert.deepEqual(await run(crmSettings, command), result);
    const receipt = await run(crmSettings, { ...command, action: "getReceipt", changes: undefined, revision: undefined });
    assert.deepEqual(receipt, result);
    const [records] = await connection.query("SELECT FLAG,SENHA FROM parametros WHERE CODIGO=1");
    assert.equal(records[0].FLAG, "N"); assert.equal(records[0].SENHA, "fixture-new-private");
    await assert.rejects(run(crmSettings, { ...command, operationId: randomUUID(), changes: [{ key: "FLAG", action: "set", value: "S" }] }), /mudou/);
    const refreshed = await run(crmSettings, base);
    const failingId = randomUUID();
    await connection.query("CREATE TRIGGER admin_fixture_receipt_failure BEFORE INSERT ON admin_operation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture receipt rejected'");
    try {
      await assert.rejects(run(crmSettings, { ...command, operationId: failingId, revision: refreshed.revision, changes: [{ key: "FLAG", action: "set", value: "S" }] }));
      const [after] = await connection.query("SELECT FLAG FROM parametros WHERE CODIGO=1"); assert.equal(after[0].FLAG, "N");
    } finally { await connection.query("DROP TRIGGER admin_fixture_receipt_failure"); }
    const tenantBase = { ...base, source: "tenant" };
    const tenantCurrent = await run(instanceSettings, tenantBase);
    assert.equal(tenantCurrent.values.privateToken, undefined);
    assert.ok(tenantCurrent.catalog.every(field => field.readOnly && field.type === "json" || field.type === "secret"));
    await assert.rejects(run(instanceSettings, { ...tenantBase, action: "saveSettings", operationId: randomUUID(), revision: tenantCurrent.revision, changes: [{ key: "flag", action: "set", value: true }] }), error => error.statusCode === 422);
    const databaseBase = { ...base, source: "database" };
    const databaseCurrent = await run(instanceSettings, databaseBase);
    const savedDatabase = await run(instanceSettings, { ...databaseBase, action: "saveSettings", operationId: randomUUID(), revision: databaseCurrent.revision, changes: [{ key: "database", action: "set", value: nextName }] });
    assert.equal(savedDatabase.application.state, "pending");
    assert.equal(savedDatabase.snapshot.inherited.database.value, crmName);
    const [activeBefore] = await connection.query(`SELECT \`database\` FROM ${safeName(registryName)}.clients_servers WHERE instance_name=?`, [tenant]);
    assert.equal(activeBefore[0].database, crmName, "saving desired destination must not change any runtime destination");
    const [encrypted] = await connection.query(`SELECT payload_encrypted FROM ${safeName(registryName)}.admin_saved_configurations`);
    assert.ok(!encrypted[0].payload_encrypted.includes(options.password));
    const nativeBefore = await getTenantDatabase().transaction(tenant, "admin-identity-before", ["parametros"], tx => tx.execute("SELECT DATABASE() AS db"));
    assert.equal(nativeBefore[0].db, crmName);
    const applied = await run(instanceSettings, { ...databaseBase, action: "applySettings", operationId: randomUUID(), revision: savedDatabase.revision });
    assert.equal(applied.application.state, "applied");
    const nativeAfter = await getTenantDatabase().transaction(tenant, "admin-identity-after", ["parametros"], tx => tx.execute("SELECT DATABASE() AS db"));
    assert.equal(nativeAfter[0].db, nextName);
    const legacyAfter = await pools.query(tenant, "SELECT DATABASE() AS db", [], { retryOnConnectionLoss: false });
    assert.equal(legacyAfter[0].db, nextName);
  } finally {
    await pools.invalidate(tenant); await closeTenantDatabase(); await prisma.$disconnect(); await connection.end();
  }
});
