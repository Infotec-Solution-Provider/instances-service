const test = require("node:test"),
	assert = require("node:assert/strict");
const { createHmac, randomUUID } = require("node:crypto");
const express = require("express");
const {
	createCatalogOrderingRouter,
} = require("../dist/controllers/catalog-ordering.controller");
const { TenantDatabaseError } = require("../dist/tenant-database/error");
test("catalog HTTP signature binds tenant, payload, path and nonce; errors are sanitized", async (t) => {
	const previous = process.env.TENANT_TRANSACTION_SECRET,
		key = "catalog-local-only-signing-key-0123456789";
	process.env.TENANT_TRANSACTION_SECRET = key;
	const calls = [];
	let failure;
	const app = express();
	app.use(express.json());
	app.use(
		createCatalogOrderingRouter({
			execute: async (tenant, body) => {
				calls.push({ tenant, body });
				if (failure) throw failure;
				return { items: [], revision: "fixture" };
			},
		}),
	);
	const server = app.listen(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	const path = "/api/instances/synthetic-a/catalog-ordering",
		base = `http://127.0.0.1:${server.address().port}`;
	const body = { action: "read", kind: "segments" };
	function headers(data = body, signedPath = path) {
		const timestamp = String(Date.now()),
			nonce = randomUUID();
		return {
			"Content-Type": "application/json",
			"x-tenant-timestamp": timestamp,
			"x-tenant-nonce": nonce,
			"x-tenant-signature": createHmac("sha256", key)
				.update(
					`${timestamp}\n${nonce}\n${signedPath}\n${JSON.stringify(data)}`,
				)
				.digest("hex"),
		};
	}
	const send = (data, auth, url = path) =>
		fetch(base + url, {
			method: "POST",
			headers: auth,
			body: JSON.stringify(data),
		});
	try {
		await t.test(
			"unsigned and tampered requests never contact the tenant",
			async () => {
				assert.equal(
					(await send(body, { "Content-Type": "application/json" }))
						.status,
					401,
				);
				assert.equal(
					(await send({ ...body, kind: "states" }, headers())).status,
					401,
				);
				assert.equal(
					(
						await send(
							body,
							headers(),
							path.replace("synthetic-a", "synthetic-b"),
						)
					).status,
					401,
				);
				assert.equal(calls.length, 0);
			},
		);
		await t.test("signed response cannot be replayed", async () => {
			const auth = headers();
			const response = await send(body, auth);
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("cache-control"), "no-store");
			assert.equal((await send(body, auth)).status, 409);
			assert.equal(calls.length, 1);
			assert.equal(calls[0].tenant, "synthetic-a");
		});
		await t.test(
			"typed rollback and unknown commit are reported without internals",
			async () => {
				failure = new TenantDatabaseError("TENANT_ORDERING_CHANGED");
				assert.equal((await send(body, headers())).status, 409);
				failure = Error("secret SQL credentials");
				const response = await send(body, headers());
				assert.equal(response.status, 503);
				assert.deepEqual(await response.json(), {
					code: "TENANT_ORDERING_FAILED",
					outcome: "UNKNOWN",
				});
				delete process.env.TENANT_TRANSACTION_SECRET;
				assert.equal((await send(body, headers())).status, 503);
			},
		);
	} finally {
		if (previous === undefined)
			delete process.env.TENANT_TRANSACTION_SECRET;
		else process.env.TENANT_TRANSACTION_SECRET = previous;
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});
