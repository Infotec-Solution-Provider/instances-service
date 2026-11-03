const test = require("node:test");
const assert = require("node:assert/strict");
const { synchronizeCustomerPhones } = require("../dist/services/customer-phone-sync");

const slots = [["AREA1", "FONE1"], ["AREA2", "FONE2"], ["AREA3", "FONE3"], ["AREAFAX", "FAX"]];
function columns() {
  return [
    ...slots.flat().map(COLUMN_NAME => ({ TABLE_NAME: "clientes", COLUMN_NAME })),
    ...["CODIGO", "CLIENTE", "FONE", "TIPO_FONE"].map(COLUMN_NAME => ({ TABLE_NAME: "fones_campanha_cli", COLUMN_NAME, DATA_TYPE: COLUMN_NAME === "FONE" || COLUMN_NAME === "TIPO_FONE" ? "varchar" : "int", IS_NULLABLE: "YES", COLUMN_DEFAULT: "", EXTRA: COLUMN_NAME === "CODIGO" ? "auto_increment" : "", COLUMN_KEY: COLUMN_NAME === "CODIGO" ? "PRI" : "", CHARACTER_MAXIMUM_LENGTH: 12 })),
  ];
}
function fixture(options = {}) {
  const queries = [], numbers = new Set(options.numbers ?? ["1133333333", "1199999999"]);
  const row = { AREA1: 11, FONE1: "33333333", AREA2: 21, FONE2: "44444444", AREA3: null, FONE3: null, AREAFAX: null, FAX: null, ...options.row };
  return { queries, numbers, tx: { tenant: "alpha", async execute(sql, params = []) {
    queries.push({ sql, params });
    if (sql.includes("information_schema.COLUMNS")) return options.columns ?? columns();
    if (sql.includes("KEY_COLUMN_USAGE")) return options.references ?? [];
    if (sql.includes("STATISTICS")) return options.indexes ?? [{ INDEX_NAME: "u", COLUMN_NAME: "CLIENTE" }, { INDEX_NAME: "u", COLUMN_NAME: "FONE" }];
    if (sql.startsWith("SELECT")) return [row];
    assert.equal(params[0], 42, "every mutation is customer-scoped");
    if (sql.startsWith("DELETE")) { for (const phone of numbers) if (!params.slice(1).includes(phone)) numbers.delete(phone); return { affectedRows: 1 }; }
    if (options.failInsert) throw new Error("fixture insert failure");
    const existed = numbers.has(params[1]); numbers.add(params[1]); return { affectedRows: existed ? 0 : 1 };
  } } };
}
test("sync replaces obsolete numbers, includes the fourth phone, deduplicates and is idempotent", async () => {
  const f = fixture({ row: { AREA3: 21, FONE3: "44444444", AREAFAX: 31, FAX: "55555555" } });
  await synchronizeCustomerPhones(f.tx, 42);
  assert.deepEqual([...f.numbers].sort(), ["1133333333", "2144444444", "3155555555"]);
  await synchronizeCustomerPhones(f.tx, 42);
  assert.equal(f.queries.filter(q => q.sql.startsWith("INSERT")).length, 6);
  assert.equal(f.queries.some(q => /^(UPDATE|DELETE FROM historico|INSERT INTO historico)/.test(q.sql)), false);
});
test("invalid pairs, empty lists and noncompact rows fail before touching the phone table", async () => {
  for (const row of [{ AREA2: 21, FONE2: null }, { AREA2: null, FONE2: "44444444" }, { AREA1: null, FONE1: null }, { AREA1: null, FONE1: null, AREA2: null, FONE2: null }]) {
    const f = fixture({ row });
    await assert.rejects(synchronizeCustomerPhones(f.tx, 42), { code: "TENANT_CUSTOMER_PHONE_INVALID", outcome: "NOT_COMMITTED" });
    assert.equal(f.queries.some(q => q.sql.startsWith("DELETE")), false);
  }
});
test("unknown schema, history references, missing uniqueness and required extra columns fail closed", async () => {
  for (const options of [{ columns: [] }, { references: [{ TABLE_NAME: "historico" }] }, { indexes: [] }, { columns: [...columns(), { TABLE_NAME: "fones_campanha_cli", COLUMN_NAME: "REQUIRED", IS_NULLABLE: "NO", COLUMN_DEFAULT: null, EXTRA: "" }] }]) {
    const f = fixture(options);
    await assert.rejects(synchronizeCustomerPhones(f.tx, 42), { code: "TENANT_CUSTOMER_PHONE_SCHEMA_UNSUPPORTED" });
    assert.equal(f.queries.some(q => /^(INSERT|DELETE)/.test(q.sql)), false);
  }
});
test("insert failure propagates to the transaction owner without retrying", async () => {
  const f = fixture({ failInsert: true });
  await assert.rejects(synchronizeCustomerPhones(f.tx, 42), /fixture insert failure/);
  assert.equal(f.queries.filter(q => q.sql.startsWith("INSERT")).length, 1);
});
