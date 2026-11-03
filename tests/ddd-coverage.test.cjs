const test = require("node:test"), assert = require("node:assert/strict");
const { associateDddCities } = require("../dist/catalog-ordering/ddd-coverage");
function fixture() {
  const coverage = new Map([[2, { city_id: 2, uf: "SP" }]]), calls = [];
  const f = { coverage, calls, name: "São Paulo", uf: "SP", triggers: false, schema: true, area: true };
  let queue = Promise.resolve();
  f.database = { transaction(tenant, operation, tables, callback) {
    assert.equal(tenant, "synthetic-a"); assert.equal(operation, "crm.ddd-coverage.associate"); assert.deepEqual(tables, ["fone_areas", "cidades", "crm_ddd_city_links"]);
    const run = queue.then(() => callback({ execute: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("information_schema.COLUMNS")) return f.schema ? [
        ["ddd","varchar",5,"PRI"], ["city_id","int",null,"PRI"], ["uf","char",2,""], ["provider_city","varchar",200,""], ["created_by","int",null,""], ["created_at","datetime",null,""]
      ].map(([COLUMN_NAME,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,COLUMN_KEY]) => ({ COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, COLUMN_KEY })) : [];
      if (sql.includes("information_schema.TRIGGERS")) return f.triggers ? [{}] : [];
      if (sql.startsWith("SELECT CODIGO FROM fone_areas")) return f.area ? [{ CODIGO: "11" }] : [];
      if (sql.startsWith("SELECT CODIGO,NOME,UF")) return params.map(CODIGO => ({ CODIGO, NOME: f.name, UF: f.uf }));
      if (sql.startsWith("SELECT city_id,uf")) return [...coverage.values()];
      if (sql.startsWith("INSERT INTO crm_ddd_city_links")) { for(let i=0;i<params.length;i+=5) coverage.set(params[i+1], { city_id: params[i+1], uf: params[i+2] }); return { affectedRows: params.length / 5 }; }
      assert.fail(sql);
    } }));
    queue = run.catch(() => {}); return run;
  } };
  return f;
}
const input = { action: "phone-area-associate", ddd: "11", uf: "SP", actorId: 7, links: [{ cityId: 1, expectedName: "São Paulo", providerCity: "SÃO PAULO" }] };
test("coverage is additive, audited and idempotent even for two concurrent identical requests", async () => {
  const f = fixture();
  const result = await Promise.all([associateDddCities(f.database, "synthetic-a", input), associateDddCities(f.database, "synthetic-a", input)]);
  assert.deepEqual(result, [{ added: 1, existing: 0 }, { added: 0, existing: 1 }]);
  assert.deepEqual([...f.coverage.keys()].sort(), [1,2]);
  const writes = f.calls.filter(call => call.sql.startsWith("INSERT"));
  assert.equal(writes.length, 1); assert.deepEqual(writes[0].params, ["11", 1, "SP", "SÃO PAULO", 7]);
  assert.ok(f.calls.filter(call => call.sql.startsWith("SELECT CODIGO")).every(call => call.sql.endsWith("FOR UPDATE")));
  assert.ok(f.calls.every(call => !/cidades_ddd|DELETE|UPDATE /.test(call.sql)));
});
test("changed name, UF or missing DDD and unknown triggers/schema never write coverage", async () => {
  for (const [flag, value, code] of [["name","Renamed","TENANT_ORDERING_CHANGED"], ["uf","RJ","TENANT_ORDERING_CHANGED"], ["area",false,"TENANT_ORDERING_CHANGED"], ["triggers",true,"TENANT_TRANSACTION_UNREVIEWED_TRIGGERS"], ["schema",false,"TENANT_ORDERING_SCHEMA_UNAVAILABLE"]]) {
    const f = fixture(); f[flag] = value;
    await assert.rejects(associateDddCities(f.database, "synthetic-a", input), { code });
    assert.equal(f.coverage.size, 1); assert.equal(f.calls.filter(call => call.sql.startsWith("INSERT")).length, 0);
  }
});
test("coverage accepts only bounded typed requests, no SQL, duplicate cities or user-specified audit actor fields", async () => {
  const f = fixture();
  for(const body of [{ ...input, sql: "DELETE FROM clientes" }, { ...input, actorId: 0 }, { ...input, ddd: "../11" }, { ...input, uf: "ZZ" }, { ...input, links: [] }, { ...input, links: [input.links[0], input.links[0]] }, { ...input, links: [{ ...input.links[0], actorId: 9 }] }]) await assert.rejects(associateDddCities(f.database, "synthetic-a", body), { code: "TENANT_ORDERING_INVALID" });
  assert.equal(f.calls.length, 0);
});
