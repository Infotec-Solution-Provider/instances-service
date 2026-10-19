require("express-async-errors");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { once } = require("node:events");
const express = require("express");
const PoolsController = require("../dist/controllers/pools.controller").default;

async function fixture(t, query) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use(new PoolsController(async (...args) => { calls.push(args); return query(...args); }).router);
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/instances/test-tenant/query-once`;
  return { calls, send: body => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) };
}

test("query-once preserves the result and disables SQL replay", async t => {
  const f = await fixture(t, async () => ({ insertId: 73, affectedRows: 1 }));
  const response = await f.send({ query: "INSERT INTO segmentos (NOME) VALUES (?)", parameters: ["Novo"] });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result, { insertId: 73, affectedRows: 1 });
  assert.deepEqual(f.calls, [["test-tenant", "INSERT INTO segmentos (NOME) VALUES (?)", ["Novo"], { retryOnConnectionLoss: false }]]);
});

test("duplicate writes have a typed response without SQL or values", async t => {
  const f = await fixture(t, async () => { throw Object.assign(new Error("duplicate private-value SQL"), { code: "ER_DUP_ENTRY", sql: "private SQL" }); });
  const response = await f.send({ query: "INSERT INTO segmentos (NOME) VALUES (?)", parameters: ["private-value"] });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { message: "Registro duplicado.", code: "TENANT_DUPLICATE_KEY", outcome: "UNKNOWN" });
  assert.equal(f.calls.length, 1);
});

test("lost acknowledgements remain UNKNOWN and are never retried", async t => {
  const f = await fixture(t, async () => { throw Object.assign(new Error("private SQL"), { code: "PROTOCOL_CONNECTION_LOST" }); });
  const response = await f.send({ query: "UPDATE segmentos SET NOME = ?", parameters: ["private-value"] });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { message: "Não foi possível confirmar a operação no banco.", code: "TENANT_QUERY_FAILED", outcome: "UNKNOWN" });
  assert.equal(f.calls.length, 1);
});
