const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac, randomUUID } = require("node:crypto");
const { createServer } = require("node:http");
const { once } = require("node:events");
const express = require("express");
const {
	createTenantTransactionsRouter,
} = require("../dist/controllers/tenant-transactions.controller");
const { TenantDatabaseError } = require("../dist/tenant-database/error");

const key = "local-test-only-transaction-key-0123456789";
const fixedNow = 1_792_400_000_000;
const batch = () => ({
	operation: "telephony.schedule.edit",
	tables: [
		"campanhas_clientes",
		"telephony_schedule_edits",
		"clientes",
		"operadores",
	],
	statements: [
		{
			sql: "UPDATE campanhas_clientes SET OPERADOR = ? WHERE CODIGO = ?",
			params: [20, 1],
			expectAffectedRows: 1,
		},
		{
			sql: "INSERT INTO telephony_schedule_edits (operation_id) VALUES (?)",
			params: ["op"],
			expectAffectedRows: 1,
		},
	],
});
async function fixture(t, options = {}) {
	const queries = [],
		transactions = [];
	const database = {
		async transaction(instance, operation, tables, callback) {
			transactions.push({ instance, operation, tables });
			if (options.error) throw options.error;
			return callback({
				async execute(sql, params) {
					queries.push({ sql, params });
					if (sql.includes("information_schema.TRIGGERS"))
						return options.triggers ?? [];
					if (/^INSERT INTO campanhas_clientes\b/.test(sql) && options.generationCount !== undefined)
						return { affectedRows: options.generationCount };
					return { affectedRows: options.affectedRows ?? 1 };
				},
			});
		},
	};
	const app = express();
	app.use(express.json());
	app.use(
		createTenantTransactionsRouter(
			() => database,
			() => (options.secret === undefined ? key : options.secret),
			() => fixedNow,
		),
	);
	const server = createServer(app);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(
		() =>
			new Promise((resolve) => {
				server.close(resolve);
				server.closeAllConnections();
			}),
	);
	const url = `http://127.0.0.1:${server.address().port}`;
	const sign = (
		body,
		path = "/api/instances/alpha/transactions",
		overrides = {},
	) => {
		const timestamp = String(overrides.timestamp ?? fixedNow),
			nonce = overrides.nonce ?? randomUUID();
		const signature = createHmac("sha256", key)
			.update(`${timestamp}\n${nonce}\n${path}\n${JSON.stringify(body)}`)
			.digest("hex");
		return {
			"content-type": "application/json",
			"x-tenant-timestamp": timestamp,
			"x-tenant-nonce": nonce,
			"x-tenant-signature": signature,
		};
	};
	const send = async (body, options = {}) => {
		const path = options.path ?? "/api/instances/alpha/transactions";
		const response = await fetch(url + path, {
			method: "POST",
			headers: options.headers ?? sign(body, path),
			body: JSON.stringify(body),
		});
		return { status: response.status, body: await response.json() };
	};
	return { transactions, queries, send, sign };
}

test("signed command binds tenant, payload and operation; executes sequentially and returns only acknowledgement", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await f.send(batch()), {
		status: 200,
		body: { data: [{ affectedRows: 1 }, { affectedRows: 1 }] },
	});
	assert.equal(f.transactions.length, 1);
	assert.equal(f.transactions[0].instance, "alpha");
	assert.match(f.queries[0].sql, /information_schema.TRIGGERS/);
	assert.match(f.queries[1].sql, /^UPDATE/);
	assert.match(f.queries[2].sql, /^INSERT/);
});
function generationBatch(count = 2) {
  return { operation: "crm.campaign.generate", tables: ["campanhas", "campanhas_clientes", "clientes", "operadores", "excecoes", "excecoes_cidade", "excecoes_estado", "excecoes_segmentos"], statements: [
    { sql: "UPDATE campanhas SET GERADO_LISTA='SIM' WHERE CODIGO=? AND GERADO_LISTA='NAO'", params: [12], expectAffectedRows: 1 },
    { sql: "INSERT INTO campanhas_clientes (CLIENTE,CAMPANHA) SELECT CODIGO,? FROM clientes LIMIT 2001", params: [12], expectAffectedRows: count },
  ] };
}
test("campaign generation uses the signed bounded operation and guards both mutated tables", async t => {
  const f=await fixture(t,{generationCount:2});
  assert.deepEqual(await f.send(generationBatch()),{status:200,body:{data:[{affectedRows:1},{affectedRows:2}]}});
  assert.equal(f.transactions[0].operation,"crm.campaign.generate");
  assert.deepEqual(f.queries[0].params,["campanhas","campanhas_clientes"]);
});
test("campaign generation rolls back a changed audience count and rejects unbounded SQL/counts", async t => {
  const f=await fixture(t,{generationCount:3});
  assert.deepEqual(await f.send(generationBatch(2)),{status:409,body:{code:"TENANT_TRANSACTION_AFFECTED_ROWS",outcome:"NOT_COMMITTED"}});
  for(const mutate of [b=>b.statements[1].expectAffectedRows=2001,b=>b.statements[1].expectAffectedRows=-1,b=>b.statements[0].expectAffectedRows=2,b=>b.statements[1].sql="DELETE FROM campanhas_clientes",b=>b.tables.pop()]){
    const body=generationBatch();mutate(body);assert.equal((await f.send(body)).status,400);
  }
});
test("no signing secret fails closed without contacting tenant", async (t) => {
	const f = await fixture(t, { secret: "" });
	assert.equal((await f.send(batch())).status, 503);
	assert.equal(f.transactions.length, 0);
});
test("unsigned, tampered payload, changed tenant and stale signature never reach tenant", async (t) => {
	const f = await fixture(t),
		body = batch(),
		headers = f.sign(body);
	assert.equal(
		(
			await f.send(body, {
				headers: { "content-type": "application/json" },
			})
		).status,
		401,
	);
	const changed = batch();
	changed.statements[0].params[0] = 999;
	assert.equal((await f.send(changed, { headers })).status, 401);
	assert.equal(
		(
			await f.send(body, {
				path: "/api/instances/beta/transactions",
				headers,
			})
		).status,
		401,
	);
	assert.equal(
		(
			await f.send(body, {
				headers: f.sign(body, undefined, {
					timestamp: fixedNow - 60001,
				}),
			})
		).status,
		401,
	);
	assert.equal(f.transactions.length, 0);
});
test("identical transport nonce is never executed twice and does not claim rollback of first attempt", async (t) => {
	const f = await fixture(t),
		body = batch(),
		headers = f.sign(body);
	assert.equal((await f.send(body, { headers })).status, 200);
	const replay = await f.send(body, { headers });
	assert.equal(replay.status, 409);
	assert.equal(replay.body.outcome, "UNKNOWN");
	assert.equal(f.transactions.length, 1);
});
test("only bounded schedule-edit statements, parameters, known tables and expected row counts are accepted", async (t) => {
	const f = await fixture(t);
	for (const mutate of [
		(b) => (b.operation = "anything"),
		(b) => b.tables.push("users"),
		(b) => (b.tables = ["campanhas_clientes"]),
		(b) => b.statements.push(b.statements[0]),
		(b) => delete b.statements[0].expectAffectedRows,
		(b) => (b.statements[0].sql += "; DELETE FROM clientes"),
		(b) => (b.statements[0].sql = "DELETE FROM campanhas_clientes"),
		(b) => (b.statements[0].params = [{}]),
		(b) =>
			(b.statements[0].sql +=
				" AND NOT EXISTS (SELECT 1 FROM campanhas_clientes_validade)"),
		(b) => (b.host = "attacker"),
	]) {
		const body = batch();
		mutate(body);
		assert.equal((await f.send(body)).status, 400);
	}
	assert.equal(f.transactions.length, 0);
});
test("CAS zero rows aborts before audit insert with a specific rollback outcome", async (t) => {
	const f = await fixture(t, { affectedRows: 0 });
	const result = await f.send(batch());
	assert.deepEqual(result, {
		status: 409,
		body: {
			code: "TENANT_TRANSACTION_AFFECTED_ROWS",
			outcome: "NOT_COMMITTED",
		},
	});
	assert.equal(f.queries.length, 2);
});
test("unknown triggers block before writing under transaction metadata locks", async (t) => {
	const f = await fixture(t, { triggers: [{ TRIGGER_NAME: "legacy" }] });
	const result = await f.send(batch());
	assert.equal(result.status, 503);
	assert.equal(result.body.code, "TENANT_TRANSACTION_UNREVIEWED_TRIGGERS");
	assert.equal(f.queries.length, 1);
});
test("commit uncertainty and untyped failures are sanitized without request data or automatic retry", async (t) => {
	for (const error of [
		new TenantDatabaseError("TENANT_COMMIT_UNKNOWN", "UNKNOWN"),
		new Error("password SQL private record"),
	]) {
		const f = await fixture(t, { error });
		const result = await f.send(batch());
		assert.equal(result.status, 503);
		assert.equal(result.body.outcome, "UNKNOWN");
		assert.doesNotMatch(JSON.stringify(result), /password|private|SQL/);
		assert.equal(f.transactions.length, 1);
	}
});
