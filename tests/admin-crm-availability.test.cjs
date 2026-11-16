const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { crmSettings } = require("../dist/admin/crm-settings");
const pools = require("../dist/services/pools.service").default;
const tenantDatabase = require("../dist/services/tenant-database.service");
const { withAdminActor } = require("../dist/admin/settings-utils");
process.env.ADMIN_REVISION_KEY = "crm-availability-test-key-longer-than-thirty-two";
const actor = { instance: "infotec", userId: 7, role: "ADMIN", name: "Component test" };
const base = { action: "getSettings", environment: "homolog", tenant: "infotec", source: "crm" };
const column = (key, extra = {}) => ({ key, type: "varchar", columnType: "varchar(100)", nullable: "YES", defaultValue: null, maxLength: 100, extra: "", ...extra });
const primary = key => column(key, { type: "int", columnType: "int", nullable: "NO", maxLength: null });
async function withQuery(query, run) {
  const original = pools.query;
  pools.query = async (tenant, sql, params, options) => {
    assert.equal(tenant, "infotec");
    assert.equal(options.retryOnConnectionLoss, false);
    return query(sql, params);
  };
  try { return await run(); } finally { pools.query = original; }
}
function assertUnavailable(value, source) {
  assert.equal(value.source, source); assert.equal(value.tenant, "infotec");
  assert.equal(typeof value.revision, "string"); assert.ok(value.revision.length > 20);
  assert.ok(value.unavailableReason); assert.deepEqual(value.catalog, []); assert.deepEqual(value.values, {});
  assert.deepEqual(value.secrets, {}); assert.deepEqual(value.resources, []); assert.equal(value.application, undefined);
}

test("missing CRM/SIP/WebRTC tables produce unavailable GET snapshots without reading values", async () => {
  for (const source of ["crm", "sip-global", "sip-user", "webrtc"]) {
    let reads = 0;
    await withQuery(async sql => { reads++; assert.ok(sql.includes("information_schema.COLUMNS")); return []; }, async () => {
      assertUnavailable(await crmSettings({ ...base, source }), source);
    });
    assert.equal(reads, 1);
  }
});

test("missing primary/relationship columns or supported fields are unavailable before data reads", async () => {
  for (const [source, columns] of [
    ["crm", [column("FLAG")]], ["crm", [primary("CODIGO")]],
    ["sip-user", [primary("COD_CONFIG_SIP"), column("RAMAL_SIP")]],
    ["sip-user", [primary("COD_OPERADOR"), column("RAMAL_SIP")]],
    ["webrtc", [column("enabled")]],
  ]) {
    await withQuery(async sql => { assert.ok(sql.includes("information_schema.COLUMNS")); return columns; }, async () => {
      assertUnavailable(await crmSettings({ ...base, source }), source);
    });
  }
});

test("unsupported SIP targets stay empty instead of listing editable operators", async () => {
  for (const columns of [[], [primary("COD_CONFIG_SIP"), column("RAMAL_SIP")]]) {
    let reads = 0;
    await withQuery(async sql => { reads++; assert.ok(sql.includes("information_schema.COLUMNS")); return columns; }, async () => {
      const result = await crmSettings({ ...base, source: "sip-user", action: "getTargets" });
      assert.deepEqual(result.targets, []); assert.equal(result.hasMore, false); assert.ok(result.unavailableReason);
    });
    assert.equal(reads, 1);
  }
});

test("available GET values and secret handling are unchanged; missing initial row is explicit", async () => {
  const columns = [primary("CODIGO"), column("FLAG", { type: "enum", columnType: "enum('S','N')" }), column("SENHA")];
  await withQuery(async sql => sql.includes("information_schema.COLUMNS") ? columns : [{ CODIGO: 1, FLAG: "S", SENHA: "component-only-secret" }], async () => {
    const result = await crmSettings(base);
    assert.equal(result.unavailableReason, undefined); assert.equal(result.values.FLAG, "S");
    assert.equal(result.application.state, "applied"); assert.equal(result.secrets.SENHA.configured, true);
    assert.ok(!JSON.stringify(result).includes("component-only-secret"));
  });
  await withQuery(async sql => sql.includes("information_schema.COLUMNS") ? columns : [], async () => {
    assertUnavailable(await crmSettings(base), "crm");
  });
});

test("available SIP targets retain their response and unknown target user remains 404", async () => {
  const columns = [primary("COD_CONFIG_SIP"), primary("COD_OPERADOR"), column("RAMAL_SIP")];
  await withQuery(async sql => sql.includes("information_schema.COLUMNS") ? columns : [{ id: 17, label: "Component operator", active: "SIM" }], async () => {
    const result = await crmSettings({ ...base, source: "sip-user", action: "getTargets" });
    assert.deepEqual(result, { targets: [{ id: 17, label: "Component operator", active: true }] });
  });
  await withQuery(async sql => sql.includes("information_schema.COLUMNS") ? columns : [], async () => {
    await assert.rejects(crmSettings({ ...base, source: "sip-user", target: { userId: 17 } }), { statusCode: 404 });
  });
});

test("connection/query and generic 503 errors are preserved, never converted to availability snapshots", async () => {
  for (const error of [Object.assign(new Error("component connection failure"), { code: "ECONNREFUSED" }), Object.assign(new Error("component query failure"), { statusCode: 503 })]) {
    for (const command of [base, { ...base, source: "sip-user", action: "getTargets" }]) {
      await withQuery(async () => { throw error; }, async () => {
        await assert.rejects(crmSettings(command), caught => caught === error);
      });
    }
  }
});

test("missing-schema writes still fail closed before any DML or receipt insert", async () => {
  const original = tenantDatabase.getTenantDatabase;
  let dml = 0;
  tenantDatabase.getTenantDatabase = () => ({ transaction: async (tenant, _name, _tables, callback) => {
    assert.equal(tenant, "infotec");
    return callback({ execute: async sql => {
      if (/^(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER)\b/i.test(sql)) dml++;
      assert.ok(sql.includes("information_schema.COLUMNS") || sql.startsWith("SELECT request_hash"));
      return [];
    } });
  } });
  try {
    for (const source of ["crm", "sip-global", "sip-user", "webrtc"])
      await assert.rejects(withAdminActor(actor, () => crmSettings({ ...base, source, action: "saveSettings", operationId: randomUUID(), revision: "unavailable-revision", changes: [{ key: "FLAG", action: "set", value: "N" }] })), { statusCode: 503 });
    assert.equal(dml, 0);
  } finally { tenantDatabase.getTenantDatabase = original; }
});

test("receipt lookups keep their actor binding and do not infer outcomes from missing configuration tables", async () => {
  const command = { ...base, action: "getReceipt", operationId: randomUUID() };
  const result = { operationId: command.operationId, state: "COMMITTED", changes: [] };
  await withQuery(async sql => {
    assert.ok(sql.startsWith("SELECT request_hash"));
    return [{ request_hash: "original-command-fingerprint", result_json: JSON.stringify({ actor, tenant: "infotec", source: "crm", target: null, result }) }];
  }, async () => {
    assert.deepEqual(await withAdminActor(actor, () => crmSettings(command)), result);
    await assert.rejects(withAdminActor({ ...actor, userId: 8 }, () => crmSettings(command)), { statusCode: 409 });
  });
});
