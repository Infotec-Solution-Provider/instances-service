const assert = require("node:assert/strict");
const test = require("node:test");
const {
	TenantDatabase,
} = require("../dist/tenant-database/tenant-database.js");
const { TenantAdmission } = require("../dist/tenant-database/admission.js");
const {
	TenantPoolRegistry,
} = require("../dist/tenant-database/pool-registry.js");
const { tenantDatabaseConfig } = require("../dist/tenant-database/config.js");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const config = (overrides) => ({
	...tenantDatabaseConfig({}),
	waitMs: 100,
	transactionMs: 150,
	...overrides,
});
const destination = (tenant, overrides = {}) => ({
	tenant,
	host: "server",
	port: 3306,
	user: "test",
	password: "private-password",
	database: tenant,
	...overrides,
});
function fakeConnection(overrides = {}) {
	const calls = [];
	return {
		calls,
		released: 0,
		destroyed: 0,
		async control(sql) {
			calls.push(sql);
			if (overrides.control) await overrides.control(sql);
		},
		async execute(sql, values) {
			calls.push(sql);
			if (sql.includes("information_schema.TABLES"))
				return values.map((name) => ({
					name,
					engine: overrides.engine ?? "InnoDB",
				}));
			if (overrides.execute) return overrides.execute(sql, values);
			return [{ id: 1 }];
		},
		release() {
			this.released++;
		},
		destroy() {
			this.destroyed++;
		},
	};
}
function fixture(options = {}) {
	const connections = [],
		events = [],
		pools = [];
	const factory = (resolved, limit) => {
		const pool = {
			resolved,
			limit,
			ended: 0,
			async acquire() {
				const connection = fakeConnection(options.connection);
				connections.push(connection);
				return options.acquire
					? options.acquire(connection)
					: connection;
			},
			async end() {
				this.ended++;
			},
		};
		pools.push(pool);
		return pool;
	};
	const db = new TenantDatabase(
		options.resolve ?? (async (tenant) => destination(tenant)),
		config(options.config),
		factory,
		(event) => events.push(event),
	);
	return { db, connections, events, pools };
}

test("single connection, sequential statements and committed return; no driver data in diagnostics", async () => {
	const f = fixture();
	try {
		const value = await f.db.transaction(
			"alpha",
			"messages.insert",
			["messages", "outbox"],
			async (tx) => {
				assert.equal(tx.tenant, "alpha");
				await tx.execute("INSERT INTO messages VALUES (?)", [
					"ação 😀 %20",
				]);
				await tx.execute("INSERT INTO outbox VALUES (?)", [1]);
				return 42;
			},
		);
		assert.equal(value, 42);
		assert.equal(f.connections.length, 1);
		const connection = f.connections[0];
		assert.equal(connection.calls.at(-1), "COMMIT");
		assert.equal(connection.released, 1);
		assert.equal(connection.destroyed, 0);
		assert.equal(f.events[0].outcome, "COMMITTED");
		assert.doesNotMatch(
			JSON.stringify(f.events),
			/private-password|INSERT|ação/,
		);
	} finally {
		await f.db.close();
	}
});

test("query failure poisons a transaction even when callback catches it; rollback without retry", async () => {
	const f = fixture({
		connection: {
			execute(sql) {
				if (sql.startsWith("INSERT"))
					throw new Error("secret SQL credentials");
				return [];
			},
		},
	});
	try {
		await assert.rejects(
			f.db.transaction("a", "insert", ["messages"], async (tx) => {
				await tx
					.execute("INSERT INTO messages VALUES (?)", [1])
					.catch(() => {});
			}),
			(error) =>
				error.code === "TENANT_TRANSACTION_QUERY_FAILED" &&
				error.outcome === "NOT_COMMITTED" &&
				!error.message.includes("secret"),
		);
		assert.equal(f.connections.length, 1);
		assert.equal(f.connections[0].calls.at(-1), "ROLLBACK");
		assert.equal(f.connections[0].calls.includes("COMMIT"), false);
	} finally {
		await f.db.close();
	}
});

test("lost COMMIT response is UNKNOWN, destroys the connection and never runs the callback again", async () => {
	const f = fixture({
		connection: {
			control(sql) {
				if (sql === "COMMIT")
					throw new Error("ECONNRESET with secret payload");
			},
		},
	});
	let callbacks = 0;
	try {
		await assert.rejects(
			f.db.transaction("a", "insert", ["messages"], async (tx) => {
				callbacks++;
				await tx.execute("INSERT INTO messages VALUES (?)", [1]);
			}),
			{ code: "TENANT_COMMIT_UNKNOWN", outcome: "UNKNOWN" },
		);
		assert.equal(callbacks, 1);
		assert.equal(f.connections[0].destroyed, 1);
		assert.equal(f.connections[0].calls.includes("ROLLBACK"), false);
		assert.doesNotMatch(
			JSON.stringify(f.events),
			/secret|payload|ECONNRESET/,
		);
	} finally {
		await f.db.close();
	}
});

test("COMMIT deadline also returns UNKNOWN", async () => {
	const f = fixture({
		config: { transactionMs: 25 },
		connection: {
			control(sql) {
				if (sql === "COMMIT") return new Promise(() => {});
			},
		},
	});
	try {
		await assert.rejects(
			f.db.transaction("a", "insert", ["messages"], async () => 1),
			{ code: "TENANT_COMMIT_UNKNOWN", outcome: "UNKNOWN" },
		);
	} finally {
		await f.db.close();
	}
});

test("callback deadline revokes the scope; late code cannot write or commit", async () => {
	const resume = deferred(),
		entered = deferred();
	const f = fixture({ config: { transactionMs: 25 } });
	let scope;
	try {
		const work = f.db.transaction(
			"a",
			"insert",
			["messages"],
			async (tx) => {
				scope = tx;
				entered.resolve();
				await resume.promise;
				return 1;
			},
		);
		await entered.promise;
		await assert.rejects(work, {
			code: "TENANT_TRANSACTION_TIMEOUT",
			outcome: "NOT_COMMITTED",
		});
		await assert.rejects(scope.execute("INSERT INTO messages VALUES (1)"), {
			code: "TENANT_TRANSACTION_CLOSED",
		});
		resume.resolve();
		await pause(5);
		assert.equal(f.connections[0].calls.includes("COMMIT"), false);
		assert.equal(f.connections[0].destroyed, 1);
	} finally {
		resume.resolve();
		await f.db.close();
	}
});

test("nontransactional tables, DDL and payload over budget stop before commit", async () => {
	const badEngine = fixture({ connection: { engine: "MyISAM" } });
	const f = fixture({ config: { maxParameterBytes: 4 } });
	try {
		await assert.rejects(
			badEngine.db.transaction("a", "write", ["messages"], async () =>
				assert.fail("must not start domain callback"),
			),
			{ code: "TENANT_TRANSACTION_REQUIRES_INNODB" },
		);
		await assert.rejects(
			f.db.transaction("a", "write", ["messages"], (tx) =>
				tx.execute("ALTER TABLE messages ADD x INT"),
			),
			{ code: "TENANT_TRANSACTION_SQL_NOT_ALLOWED" },
		);
		await assert.rejects(
			f.db.transaction("a", "write", ["messages"], (tx) =>
				tx.execute("INSERT INTO messages VALUES (?)", ["😀😀"]),
			),
			{ code: "TENANT_TRANSACTION_BYTE_LIMIT" },
		);
		assert.ok(
			f.connections.every(
				(connection) => !connection.calls.includes("COMMIT"),
			),
		);
	} finally {
		await badEngine.db.close();
		await f.db.close();
	}
});

test("queue rejects excess work, expires waiters and allows an independent server through", async () => {
	const gate = new TenantAdmission(
		config({
			activeGlobal: 2,
			activePerServer: 1,
			connectionsPerTenant: 1,
			pendingPerTenant: 1,
			waitMs: 30,
		}),
	);
	const first = await gate.enter("a", "one");
	const pending = gate.enter("a", "one");
	const pendingCheck = assert.rejects(pending, {
		code: "TENANT_DATABASE_WAIT_TIMEOUT",
	});
	await assert.rejects(gate.enter("a", "one"), {
		code: "TENANT_DATABASE_BUSY",
	});
	const independent = await gate.enter("b", "two");
	assert.equal(gate.snapshot().active, 2);
	await pendingCheck;
	first();
	first();
	independent();
	gate.close();
	assert.deepEqual(gate.snapshot(), { active: 0, pending: 0 });
});

test("late acquired connection is destroyed and cannot reach the domain callback", async () => {
	const late = deferred();
	const f = fixture({
		config: { waitMs: 25 },
		acquire: (connection) => late.promise.then(() => connection),
	});
	try {
		await assert.rejects(
			f.db.transaction("a", "read", ["messages"], async () =>
				assert.fail("late callback"),
			),
			{ code: "TENANT_CONNECTION_UNAVAILABLE" },
		);
		late.resolve();
		await pause(5);
		assert.equal(f.connections[0].destroyed, 1);
	} finally {
		late.resolve();
		await f.db.close();
	}
});

test("stalled destination resolution is single-flight and globally bounded after caller timeout", async () => {
	let calls = 0;
	const f = fixture({
		config: { waitMs: 20, pendingGlobal: 1 },
		resolve: () => {
			calls++;
			return new Promise(() => {});
		},
	});
	try {
		for (let i = 0; i < 2; i++)
			await assert.rejects(
				f.db.transaction("a", "read", ["messages"], async () => 1),
				{ code: "TENANT_DESTINATION_UNAVAILABLE" },
			);
		await assert.rejects(
			f.db.transaction("b", "read", ["messages"], async () => 1),
			{ code: "TENANT_DESTINATION_BUSY" },
		);
		assert.equal(calls, 1);
		assert.equal(f.db.snapshot().resolving, 1);
	} finally {
		await f.db.close();
	}
});

test("destination mismatch is rejected without creating a pool", async () => {
	const f = fixture({ resolve: async () => destination("another-tenant") });
	try {
		await assert.rejects(
			f.db.transaction("a", "read", ["messages"], async () => 1),
			{ code: "TENANT_DESTINATION_INVALID" },
		);
		assert.equal(f.pools.length, 0);
	} finally {
		await f.db.close();
	}
});

test("pool capacity includes idle and closing pools; active destinations cannot be replaced", async () => {
	const pools = [],
		closing = deferred();
	const registry = new TenantPoolRegistry(
		config({ maxPools: 1, maxPoolsPerServer: 1 }),
		(d) => {
			const pool = {
				tenant: d.tenant,
				async acquire() {},
				async end() {
					if (d.tenant === "a") await closing.promise;
				},
			};
			pools.push(pool);
			return pool;
		},
	);
	try {
		const first = await registry.lease(destination("a"));
		await assert.rejects(
			registry.lease(destination("a", { password: "rotated" })),
			{ code: "TENANT_DESTINATION_CHANGED" },
		);
		await assert.rejects(registry.lease(destination("b")), {
			code: "TENANT_POOL_CAPACITY",
		});
		first.release();
		const next = registry.lease(destination("b"));
		await pause(5);
		assert.deepEqual(registry.snapshot(), { pools: 0, closingPools: 1 });
		await assert.rejects(registry.lease(destination("c")), {
			code: "TENANT_POOL_CAPACITY",
		});
		assert.equal(pools.length, 1);
		closing.resolve();
		const second = await next;
		second.release();
		await registry.sweep(Date.now() + 100000);
		assert.equal(registry.snapshot().pools, 0);
	} finally {
		closing.resolve();
		await registry.close();
	}
});

test("close drains an active transaction, rejects queued work and does not interrupt its commit", async () => {
	const resume = deferred(),
		entered = deferred();
	const f = fixture({ config: { connectionsPerTenant: 1 } });
	const first = f.db.transaction("a", "insert", ["messages"], async () => {
		entered.resolve();
		await resume.promise;
		return 1;
	});
	await entered.promise;
	const second = f.db.transaction("a", "insert", ["messages"], async () => 2);
	const rejected = assert.rejects(second, { code: "TENANT_DATABASE_CLOSED" });
	await pause(5);
	const shutdown = f.db.close();
	resume.resolve();
	assert.equal(await first, 1);
	await rejected;
	await shutdown;
	assert.equal(f.pools[0].ended, 1);
});

test("shared-server queue has its own cap even when waiting tenants differ", async () => {
	const gate = new TenantAdmission(
		config({ activePerServer: 1, pendingPerServer: 1 }),
	);
	const release = await gate.enter("a", "one");
	const pending = gate.enter("b", "one");
	await assert.rejects(gate.enter("c", "one"), {
		code: "TENANT_DATABASE_BUSY",
	});
	const other = await gate.enter("d", "two");
	other();
	release();
	(await pending)();
	gate.close();
});

test("a concurrent or forgotten query cannot commit behind the caller", async () => {
	const result = deferred();
	const f = fixture({
		connection: {
			execute(sql) {
				if (sql.startsWith("INSERT")) return result.promise;
				return [];
			},
		},
	});
	try {
		await assert.rejects(
			f.db.transaction("a", "insert", ["messages"], async (tx) => {
				void tx.execute("INSERT INTO messages VALUES (1)");
			}),
			{ code: "TENANT_TRANSACTION_QUERY_NOT_AWAITED" },
		);
		await assert.rejects(
			f.db.transaction("a", "insert", ["messages"], async (tx) => {
				void tx.execute("INSERT INTO messages VALUES (1)");
				await tx.execute("INSERT INTO messages VALUES (2)");
			}),
			{ code: "TENANT_TRANSACTION_CONCURRENT_QUERY" },
		);
		result.resolve([]);
		await pause(5);
		assert.ok(
			f.connections.every(
				(connection) =>
					connection.destroyed === 1 &&
					!connection.calls.includes("COMMIT"),
			),
		);
	} finally {
		result.resolve([]);
		await f.db.close();
	}
});

test("release or diagnostic failure cannot turn an acknowledged commit into a failed operation", async () => {
	const connection = fakeConnection();
	connection.release = () => {
		throw new Error("release failed");
	};
	const db = new TenantDatabase(
		async (tenant) => destination(tenant),
		config(),
		() => ({ acquire: async () => connection, end: async () => {} }),
		() => {
			throw new Error("diagnostic failed");
		},
	);
	try {
		assert.equal(
			await db.transaction("a", "insert", ["messages"], async () => 42),
			42,
		);
		assert.equal(db.snapshot().committed, 1);
		assert.equal(connection.destroyed, 1);
	} finally {
		await db.close();
	}
});

test("configuration rejects unlimited/invalid budgets", () => {
	for (const value of ["0", "-1", "1.5", "NaN", "999999"])
		assert.throws(() =>
			tenantDatabaseConfig({ TENANT_DB_ACTIVE_GLOBAL: value }),
		);
	assert.equal(tenantDatabaseConfig({}).connectionsPerTenant, 2);
});
