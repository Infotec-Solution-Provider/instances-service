const test = require("node:test"), assert = require("node:assert/strict");
const { CatalogOrderingService } = require("../dist/catalog-ordering/service");
const { writePhoneArea } = require("../dist/catalog-ordering/phone-areas");
const { TenantDatabaseError } = require("../dist/tenant-database/error");

function fixture() {
  const tenants = new Map([["synthetic-a", new Map([["11", "Original"], ["0011", null]])], ["synthetic-b", new Map([["11", "Other tenant"]])]]);
  const calls = [], transactions = [];
  let tail = Promise.resolve();
  const state = { schema: true, triggers: false, tenants, calls, transactions };
  state.database = { transaction(tenant, operation, tables, work) {
    transactions.push({ tenant, operation, tables });
    const run = tail.then(async () => {
      const data = tenants.get(tenant);
      const before = new Map(data);
      try {
        return await work({ tenant, execute: async (sql, params = []) => {
          calls.push({ tenant, sql, params });
          if (sql.includes("information_schema.COLUMNS")) return state.schema ? [
            { COLUMN_NAME: "CODIGO", DATA_TYPE: "varchar", CHARACTER_MAXIMUM_LENGTH: 5, COLUMN_KEY: "PRI" },
            { COLUMN_NAME: "DESCRICAO", DATA_TYPE: "varchar", CHARACTER_MAXIMUM_LENGTH: 20, COLUMN_KEY: "" },
          ] : [{ COLUMN_NAME: "CODIGO", DATA_TYPE: "int", COLUMN_KEY: "PRI" }];
          if (sql.includes("information_schema.TRIGGERS")) return state.triggers ? [{ TRIGGER_NAME: "unknown" }] : [];
          if (sql.startsWith("SELECT CODIGO,DESCRICAO")) return data.has(params[0]) ? [{ CODIGO: params[0], DESCRICAO: data.get(params[0]) }] : [];
          if (sql.startsWith("INSERT INTO fone_areas")) { if (data.has(params[0])) throw new TenantDatabaseError("TENANT_DUPLICATE_KEY"); data.set(params[0], params[1]); return { affectedRows: 1 }; }
          if (sql.startsWith("UPDATE fone_areas SET DESCRICAO")) { if (data.get(params[1]) !== params[2]) return { affectedRows: 0 }; data.set(params[1], params[0]); return { affectedRows: 1 }; }
          assert.fail(`Unexpected SQL: ${sql}`);
        } });
      } catch (error) { tenants.set(tenant, before); throw error; }
    });
    tail = run.catch(() => {}); return run;
  } };
  return state;
}
const create = (code = "12") => ({ action: "phone-area-create", fields: { CODIGO: code, DESCRICAO: "Description" } });
const patch = (label, original = "Original", code = "11") => ({ action: "phone-area-patch", fields: { CODIGO: code, DESCRICAO: label }, expected: { DESCRICAO: original } });
test("DDD commands preserve textual identity, tenant isolation and explicit CAS", async () => {
  const f = fixture(), service = new CatalogOrderingService(f.database);
  assert.deepEqual(await service.execute("synthetic-a", create()), { CODIGO: "12", DESCRICAO: "Description" });
  assert.deepEqual(await service.execute("synthetic-a", patch("Updated")), { CODIGO: "11", DESCRICAO: "Updated" });
  await service.execute("synthetic-a", patch("Legacy", null, "0011"));
  assert.equal(f.tenants.get("synthetic-a").get("0011"), "Legacy");
  assert.equal(f.tenants.get("synthetic-b").get("11"), "Other tenant");
  assert.ok(f.calls.filter(c => c.sql.startsWith("SELECT CODIGO,DESCRICAO")).every(c => c.sql.endsWith("FOR UPDATE")));
  assert.ok(f.calls.filter(c => /^(UPDATE|INSERT)/.test(c.sql)).every(c => !/cidades_ddd|clientes|SET CODIGO/.test(c.sql)));
  assert.ok(f.transactions.every(t => t.tenant === "synthetic-a" && t.tables.join() === "fone_areas"));
});
test("two simultaneous edits with one snapshot produce one success and one conflict", async () => {
  const f = fixture();
  const outcomes = await Promise.allSettled([writePhoneArea(f.database, "synthetic-a", patch("First")), writePhoneArea(f.database, "synthetic-a", patch("Second"))]);
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(outcomes.find(r => r.status === "rejected").reason.code, "TENANT_ORDERING_CHANGED");
  assert.equal(f.tenants.get("synthetic-a").get("11"), "First");
});
test("concurrent creation never silently replaces an existing area", async () => {
  const f = fixture();
  const outcomes = await Promise.allSettled([writePhoneArea(f.database, "synthetic-a", create()), writePhoneArea(f.database, "synthetic-a", create())]);
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(outcomes.find(r => r.status === "rejected").reason.code, "TENANT_DUPLICATE_KEY");
});
test("a no-op checks the original under lock and stale/absent records cannot pass", async () => {
  const f = fixture();
  await writePhoneArea(f.database, "synthetic-a", patch("Original"));
  assert.equal(f.calls.filter(c => c.sql.startsWith("UPDATE")).length, 0);
  await assert.rejects(writePhoneArea(f.database, "synthetic-a", patch("Stale", "Stale")), { code: "TENANT_ORDERING_CHANGED" });
  await assert.rejects(writePhoneArea(f.database, "synthetic-a", patch("None", "None", "99")), { code: "TENANT_ORDERING_CHANGED" });
});
test("capability discovery and unreviewed triggers fail closed before mutation", async () => {
  for (const flag of ["schema", "triggers"]) {
    const f = fixture(); f[flag] = flag === "triggers";
    await assert.rejects(writePhoneArea(f.database, "synthetic-a", create()), { code: flag === "schema" ? "TENANT_ORDERING_SCHEMA_UNAVAILABLE" : "TENANT_TRANSACTION_UNREVIEWED_TRIGGERS" });
    assert.equal(f.calls.filter(c => /^(UPDATE|INSERT)/.test(c.sql)).length, 0);
  }
});
test("typed command rejects SQL, renames, deletion and malformed codes before connecting", async () => {
  const f = fixture();
  for (const input of [
    { ...create(), sql: "DELETE FROM clientes" },
    { ...create(), expected: { DESCRICAO: "A" } },
    { action: "phone-area-delete", fields: { CODIGO: "11" } },
    { action: "phone-area-patch", fields: { CODIGO: "11", DESCRICAO: "A", NEW_CODE: "12" }, expected: { DESCRICAO: "Original" } },
    { action: "phone-area-patch", fields: { CODIGO: "11", DESCRICAO: "A" }, expected: {} },
    ...[11, "011", "00", "1'", "http://a"].map(CODIGO => ({ ...create(), fields: { CODIGO, DESCRICAO: "A" } })),
  ]) await assert.rejects(writePhoneArea(f.database, "synthetic-a", input), { code: "TENANT_ORDERING_INVALID" });
  assert.equal(f.transactions.length, 0);
});
