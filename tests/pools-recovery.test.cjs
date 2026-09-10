const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const ClientPool = require("../dist/entities/client-pool.entity.js").default;

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function mockConnection(t, query = (_sql, callback) => callback(null)) {
	return {
		query: t.mock.fn(query),
		release: t.mock.fn(),
		destroy: t.mock.fn(),
	};
}

function loadPools(t, options = {}) {
	const created = [];
	const intervals = [];
	const serverLookup = t.mock.fn(
		options.getServer ??
			(async () => ({
				host: "test.invalid",
				port: 3306,
				username: "test",
				password: "test",
				database: "test",
			})),
	);
	const createPool = t.mock.fn(() => {
		const rawPool = new EventEmitter();
		rawPool.query = t.mock.fn(
			options.query ?? ((_sql, _params, callback) => callback(null, [])),
		);
		rawPool.end = t.mock.fn(options.end ?? ((callback) => callback(null)));
		created.push(rawPool);
		return rawPool;
	});

	t.mock.method(global, "setInterval", (callback, milliseconds) => {
		const timer = { callback, milliseconds, unref: t.mock.fn() };
		intervals.push(timer);
		return timer;
	});
	t.mock.method(console, "error", () => {});
	t.mock.method(console, "log", () => {});
	t.mock.method(console, "warn", () => {});

	const servicePath = require.resolve("../dist/services/pools.service.js");
	const replacements = new Map([
		[require.resolve("mysql2"), { createPool }],
		[
			require.resolve("../dist/services/servers.service.js"),
			{ __esModule: true, default: { get: serverLookup } },
		],
	]);
	const originals = new Map();
	for (const [path, exports] of replacements) {
		originals.set(path, require.cache[path]);
		require.cache[path] = {
			id: path,
			filename: path,
			loaded: true,
			exports,
		};
	}
	delete require.cache[servicePath];
	let PoolsService;
	try {
		PoolsService = require(servicePath).default;
	} finally {
		for (const [path, original] of originals) {
			if (original) require.cache[path] = original;
			else delete require.cache[path];
		}
		delete require.cache[servicePath];
	}
	return { PoolsService, created, intervals, serverLookup, createPool };
}

test("concurrent first queries share one pool and one server lookup", async (t) => {
	const server = deferred();
	const { PoolsService, serverLookup, createPool } = loadPools(t, {
		getServer: () => server.promise,
	});
	const queries = Array.from({ length: 12 }, () =>
		PoolsService.query("tenant", "SELECT value FROM records", []),
	);
	assert.equal(serverLookup.mock.callCount(), 1);
	server.resolve({ host: "test.invalid", port: 3306 });
	await Promise.all(queries);
	assert.equal(createPool.mock.callCount(), 1);
	assert.equal(PoolsService.pools.length, 1);
});

test("failed creation clears its shared promise so the next query can recover", async (t) => {
	let calls = 0;
	const { PoolsService, createPool } = loadPools(t, {
		getServer: async () => {
			if (++calls === 1) throw new Error("temporary catalog failure");
			return { host: "test.invalid", port: 3306 };
		},
	});
	await assert.rejects(
		PoolsService.query("tenant", "SELECT 1", []),
		/temporary catalog failure/,
	);
	await PoolsService.query("tenant", "SELECT 1", []);
	assert.equal(calls, 2);
	assert.equal(createPool.mock.callCount(), 1);
});

test("pool recreation retains a single unreferenced health timer", async (t) => {
	const { PoolsService, intervals } = loadPools(t);
	for (let i = 0; i < 4; i++) {
		const pool = await PoolsService.getOrCreatePool("tenant");
		PoolsService.removePool(pool);
	}
	assert.equal(intervals.length, 1);
	assert.equal(intervals[0].milliseconds, 30000);
	assert.equal(intervals[0].unref.mock.callCount(), 1);
});

test("health rounds do not overlap and a delayed failure cannot remove a replacement", async (t) => {
	const { PoolsService, created } = loadPools(t);
	const oldPool = await PoolsService.getOrCreatePool("tenant");
	const pendingPing = deferred();
	const ping = t.mock.method(oldPool, "ping", () => pendingPing.promise);
	const firstRound = PoolsService.checkPoolsHealth();
	await PoolsService.checkPoolsHealth();
	assert.equal(ping.mock.callCount(), 1);

	PoolsService.removePool(oldPool);
	const replacement = await PoolsService.getOrCreatePool("tenant");
	pendingPing.reject(new Error("late old connection failure"));
	await firstRound;
	created[0].emit("error", { code: "PROTOCOL_CONNECTION_LOST" });
	assert.deepEqual(PoolsService.pools, [replacement]);
	assert.equal(created[1].end.mock.callCount(), 0);

	const newPing = t.mock.method(replacement, "ping", async () => {});
	await PoolsService.checkPoolsHealth();
	assert.equal(newPing.mock.callCount(), 1);
});

test("an unfinished graceful shutdown cannot block recreation or later removals", async (t) => {
	const { PoolsService, created } = loadPools(t, { end: () => {} });
	const first = await PoolsService.getOrCreatePool("tenant");
	PoolsService.removePool(first);
	const second = await PoolsService.getOrCreatePool("tenant");
	PoolsService.removePool(second);
	const third = await PoolsService.getOrCreatePool("tenant");
	assert.deepEqual(PoolsService.pools, [third]);
	assert.equal(created[0].end.mock.callCount(), 1);
	assert.equal(created[1].end.mock.callCount(), 1);
});

test("a busy health check preserves the pool and in-flight user queries", async (t) => {
	const { PoolsService, created } = loadPools(t);
	const pool = await PoolsService.getOrCreatePool("tenant");
	t.mock.method(pool, "ping", async () => {
		throw Object.assign(new Error("no free connection before deadline"), {
			code: "POOL_HEALTH_CHECK_BUSY",
		});
	});
	await PoolsService.checkPoolsHealth();
	assert.deepEqual(PoolsService.pools, [pool]);
	assert.equal(created[0].end.mock.callCount(), 0);
});

test("network timeouts do not cause SQL replay or change query parameters", async (t) => {
	const timeout = Object.assign(new Error("connection timeout"), {
		code: "ETIMEDOUT",
	});
	const { PoolsService, created } = loadPools(t, {
		query: (_sql, _parameters, callback) => callback(timeout),
	});
	const parameters = [123, "value"];
	const sql = "INSERT INTO records VALUES (?, ?)";
	await assert.rejects(
		PoolsService.query("tenant", sql, parameters),
		timeout,
	);
	assert.equal(created[0].query.mock.callCount(), 1);
	assert.equal(created[0].query.mock.calls[0].arguments[0], sql);
	assert.equal(created[0].query.mock.calls[0].arguments[1], parameters);
	assert.equal(created[0].end.mock.callCount(), 0);
});

test("health deadline covers the connection queue and releases a late connection without querying it", async (t) => {
	let acquired;
	const connection = mockConnection(t);
	const pool = new ClientPool("tenant", {
		getConnection(callback) {
			acquired = callback;
		},
	});
	await assert.rejects(pool.ping(15), { code: "POOL_HEALTH_CHECK_BUSY" });
	acquired(null, connection);
	assert.equal(connection.query.mock.callCount(), 0);
	assert.equal(connection.release.mock.callCount(), 1);
	assert.equal(connection.destroy.mock.callCount(), 0);
});

test("health deadline destroys only its acquired connection and ignores a late response", async (t) => {
	let queryCallback;
	let userQueryCallback;
	const connection = mockConnection(t, (_sql, callback) => {
		queryCallback = callback;
	});
	const pool = new ClientPool("tenant", {
		getConnection(callback) {
			callback(null, connection);
		},
		query(_sql, _parameters, callback) {
			userQueryCallback = callback;
		},
	});
	const userQuery = pool.query("SELECT value FROM records", []);
	await assert.rejects(pool.ping(15), { code: "POOL_HEALTH_CHECK_TIMEOUT" });
	queryCallback(null);
	assert.equal(connection.destroy.mock.callCount(), 1);
	assert.equal(connection.release.mock.callCount(), 0);
	userQueryCallback(null, [{ value: "completed" }]);
	assert.deepEqual(await userQuery, [{ value: "completed" }]);
});

test("successful health check releases its connection without destroying it", async (t) => {
	const connection = mockConnection(t);
	const pool = new ClientPool("tenant", {
		getConnection(callback) {
			callback(null, connection);
		},
	});
	await pool.ping(100);
	assert.equal(connection.query.mock.calls[0].arguments[0], "SELECT 1");
	assert.equal(connection.release.mock.callCount(), 1);
	assert.equal(connection.destroy.mock.callCount(), 0);
});

test("a synchronous driver query failure rejects the request instead of leaving it pending", async () => {
	const driverError = new Error("invalid query arguments");
	const pool = new ClientPool("tenant", {
		query() {
			throw driverError;
		},
	});
	await assert.rejects(pool.query("SELECT 1", []), driverError);
});
