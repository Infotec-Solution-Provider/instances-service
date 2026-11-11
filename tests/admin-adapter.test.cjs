const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, randomUUID } = require("node:crypto");
const express = require("express");
const protocol = require("../dist/admin/admin-protocol");
const utils = require("../dist/admin/settings-utils");
const { createAdminRouter } = require("../dist/admin/router");
const { adminParserError } = require("../dist/admin/parser-error");

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const actor = { instance: "infotec", userId: 7, role: "ADMIN", name: "Test" };
process.env.ADMIN_ENVIRONMENT = "homolog";
process.env.ADMIN_REVISION_KEY = "test-only-revision-key-with-at-least-32-characters";
process.env.ADMIN_CONTROL_PUBLIC_KEYS = JSON.stringify([{ kid: "test", publicKey, environments: ["homolog"], issuer: "test" }]);
const sign = (command, audience) => protocol.signAdminCommand(command, actor, { privateKey, kid: "test", issuer: "test", audience });
async function request(command, audience, signedBody = command) {
  const app = express(); app.use(express.json()); app.use(createAdminRouter());
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/api/internal/admin`, { method: "POST", headers: { "content-type": "application/json", "x-admin-context": sign(signedBody, audience) }, body: JSON.stringify(command) });
    return { status: result.status, body: await result.json() };
  } finally { await new Promise(resolve => server.close(resolve)); }
}
test("signed delegation is restricted to CRM sources and explicit actions", async () => {
  assert.equal((await request({ action: "listSources", environment: "homolog", source: "tenant" }, "instances")).status, 200);
  assert.equal((await request({ action: "getSettings", environment: "homolog", tenant: "other", source: "database" }, "users")).status, 403);
  assert.equal((await request({ action: "listTenants", environment: "homolog", tenant: "other", source: "crm" }, "users")).status, 403);
  const original = { action: "getSettings", environment: "homolog", tenant: "first", source: "crm" };
  assert.equal((await request({ ...original, tenant: "second" }, "users", original)).status, 403);
  assert.equal((await request({ action: "listSources", environment: "production" }, "instances")).status, 403);
});
test("malformed credential bodies are rejected before reaching the general error logger", async () => {
  let logged = false;
  const app = express(); app.use(express.json({ limit: "1kb" })); app.use(createAdminRouter()); app.use(adminParserError);
  app.use((error, _req, res, _next) => { logged = true; res.status(500).json({ message: error.message }); });
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/internal/admin`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"password":"private-broken"' });
    assert.equal(response.status, 400); assert.ok(!(await response.text()).includes("private-broken")); assert.equal(logged, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test("secret snapshots, diffs and opaque revisions never reveal old credentials", () => {
  const command = { action: "getSettings", source: "tenant", tenant: "other", environment: "homolog" };
  const state = { password: "old-private", nested: { headers: { token: "nested-private" } }, connection: "mysql://user:private@host/db", normal: "visible" };
  const fields = Object.keys(state).map(key => ({ key, label: key, description: "", category: "", type: "json" }));
  const saved = utils.snapshot(command, state, fields);
  const text = JSON.stringify(saved);
  assert.ok(!text.includes("old-private") && !text.includes("nested-private") && !text.includes("user:private"));
  assert.equal(saved.values.normal, "visible"); assert.equal(saved.secrets.password.configured, true);
  const audit = utils.diff([{ key: "password", action: "set", value: "new-private" }], state, { ...state, password: "new-private" }, fields);
  assert.deepEqual(audit, [{ key: "password", secretAction: "replaced" }]);
  assert.notEqual(saved.revision, utils.snapshot({ ...command, tenant: "another" }, state, fields).revision);
  assert.throws(() => protocol.requireRevision("stale", saved.revision), /mudou/);
});
test("receipt lookup binds actor tenant source and target, while mutation replay binds original payload", async () => {
  const command = { action: "saveSettings", environment: "homolog", tenant: "other", source: "tenant", target: { scope: "INSTANCE" }, operationId: randomUUID(), revision: "test", changes: [{ key: "flag", action: "set", value: true }] };
  let stored;
  const query = async (sql, params) => { if (sql.startsWith("INSERT")) { stored = { request_hash: params[1], result_json: params[2] }; return 1; } return stored ? [stored] : []; };
  const result = { operationId: command.operationId, state: "COMMITTED", changes: [{ key: "flag", before: false, after: true }] };
  await utils.withAdminActor(actor, () => utils.writeReceipt(query, command, result));
  assert.deepEqual(await utils.withAdminActor(actor, () => utils.readReceipt(query, { ...command, action: "getReceipt", revision: undefined, changes: undefined })), result);
  await assert.rejects(utils.withAdminActor(actor, () => utils.readReceipt(query, { ...command, changes: [{ key: "flag", action: "set", value: false }] })), /outro conteúdo/);
  await assert.rejects(utils.withAdminActor({ ...actor, userId: 8 }, () => utils.readReceipt(query, { ...command, action: "getReceipt" })), /outro ator/);
  await assert.rejects(utils.withAdminActor(actor, () => utils.readReceipt(query, { ...command, action: "getReceipt", tenant: "different" })), /outro ator/);
});
test("transactional preflight pins metadata and refuses missing receipt or MyISAM", async () => {
  const seen = [];
  const query = async (sql, params) => { seen.push(sql); return sql.includes("information_schema") ? params.map(name => ({ name, engine: name === "parametros" ? "MyISAM" : "InnoDB" })) : []; };
  await assert.rejects(utils.requireTransactional(query, ["parametros", "admin_operation_receipts"]), /transacionais/);
  assert.ok(seen[0].startsWith("SELECT 1 FROM")); assert.ok(seen[1].startsWith("SELECT 1 FROM"));
});
test("staged configuration is encrypted and bound to its environment and tenant", () => {
  const { sealConfiguration, openConfiguration } = require("../dist/admin/saved-configuration");
  const value = { host: "fixture", password: "fixture-private-password" };
  const sealed = sealConfiguration("homolog:database:tenant-a", value);
  assert.ok(!sealed.includes(value.password)); assert.deepEqual(openConfiguration("homolog:database:tenant-a", sealed), value);
  assert.throws(() => openConfiguration("production:database:tenant-a", sealed), /protegida/);
  assert.throws(() => openConfiguration("homolog:database:tenant-b", sealed), /protegida/);
});
test("tenant pool invalidation blocks new leases and lets current transactions drain", async () => {
  const { TenantPoolRegistry } = require("../dist/tenant-database/pool-registry");
  const { tenantDatabaseConfig } = require("../dist/tenant-database/config");
  const pools = [];
  const registry = new TenantPoolRegistry(tenantDatabaseConfig({}), destination => {
    const pool = { tenant: destination.tenant, ended: false, acquire: async () => {}, end: async () => { pool.ended = true; } };
    pools.push(pool); return pool;
  });
  const destination = tenant => ({ tenant, host: "fixture", port: 3306, user: "fixture", password: "fixture", database: tenant });
  try {
    const old = await registry.lease(destination("one")), other = await registry.lease(destination("two"));
    await registry.invalidate("one"); assert.equal(pools[0].ended, false); assert.equal(pools[1].ended, false);
    await assert.rejects(registry.lease(destination("one")), { code: "TENANT_DESTINATION_CHANGED" });
    old.release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(pools[0].ended, true); assert.equal(pools[1].ended, false);
    const fresh = await registry.lease(destination("one")); assert.equal(pools.length, 3); fresh.release(); other.release();
  } finally { await registry.close(); }
});
test("CRM mutations atomically record redacted receipts, reject stale revisions and roll back receipt failures", async () => {
  const tenantDatabase = require("../dist/services/tenant-database.service");
  const pools = require("../dist/services/pools.service").default;
  const { crmSettings } = require("../dist/admin/crm-settings");
  const originalDatabase = tenantDatabase.getTenantDatabase, originalQuery = pools.query;
  let state = { CODIGO: 1, FLAG: "S", SENHA: "old-private" }, receipts = new Map(), writes = 0, failReceipt = false;
  const columns = [
    { key: "CODIGO", type: "int", columnType: "int", nullable: "NO", defaultValue: null, maxLength: null, extra: "" },
    { key: "FLAG", type: "enum", columnType: "enum('S','N')", nullable: "NO", defaultValue: "N", maxLength: 1, extra: "" },
    { key: "SENHA", type: "varchar", columnType: "varchar(100)", nullable: "YES", defaultValue: null, maxLength: 100, extra: "" },
  ];
  const query = async (sql, params = []) => {
    if (sql.includes("information_schema.COLUMNS")) return columns;
    if (sql.startsWith("SELECT request_hash")) return receipts.has(params[0]) ? [receipts.get(params[0])] : [];
    if (sql.startsWith("SELECT") && sql.includes("FROM `parametros`")) return [{ ...state }];
    if (sql.startsWith("UPDATE `parametros`")) { let index = 0; for (const match of sql.matchAll(/`([^`]+)`=(DEFAULT|\?)/g)) state[match[1]] = match[2] === "DEFAULT" ? columns.find(column => column.key === match[1]).defaultValue : params[index++]; writes++; return { affectedRows: 1 }; }
    if (sql.startsWith("INSERT INTO admin_operation_receipts")) { if (failReceipt) throw new Error("receipt-write-failed"); receipts.set(params[0], { request_hash: params[1], result_json: params[2] }); return { affectedRows: 1 }; }
    throw new Error(`Unexpected test statement: ${sql}`);
  };
  tenantDatabase.getTenantDatabase = () => ({ transaction: async (_tenant, _operation, tables, callback) => {
    assert.ok(tables.includes("parametros") && tables.includes("admin_operation_receipts"));
    const previous = { ...state }, previousReceipts = new Map(receipts);
    try { return await callback({ execute: query }); } catch (error) { state = previous; receipts = previousReceipts; throw error; }
  } });
  pools.query = async (_tenant, sql, params) => query(sql, params);
  const base = { action: "getSettings", environment: "homolog", tenant: "other", source: "crm" };
  try {
    const initial = await crmSettings(base);
    const command = { ...base, action: "saveSettings", operationId: randomUUID(), revision: initial.revision, changes: [{ key: "FLAG", action: "set", value: "N" }, { key: "SENHA", action: "set", value: "new-private" }] };
    const result = await utils.withAdminActor(actor, () => crmSettings(command));
    assert.equal(result.state, "COMMITTED"); assert.equal(state.FLAG, "N"); assert.equal(state.SENHA, "new-private");
    assert.ok(!JSON.stringify(result).includes("old-private") && !JSON.stringify(result).includes("new-private"));
    const writesAfterCommit = writes;
    assert.deepEqual(await utils.withAdminActor(actor, () => crmSettings(command)), result);
    assert.equal(writes, writesAfterCommit, "idempotent replay must not perform another UPDATE");
    await assert.rejects(utils.withAdminActor(actor, () => crmSettings({ ...command, operationId: randomUUID(), changes: [{ key: "FLAG", action: "set", value: "S" }] })), /mudou/);
    const latest = await crmSettings(base); failReceipt = true;
    await assert.rejects(utils.withAdminActor(actor, () => crmSettings({ ...command, operationId: randomUUID(), revision: latest.revision, changes: [{ key: "FLAG", action: "set", value: "S" }] })), /recibo/);
    assert.equal(state.FLAG, "N", "receipt failure must roll back the value in the owner transaction");
  } finally { tenantDatabase.getTenantDatabase = originalDatabase; pools.query = originalQuery; }
});
