const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

function loadService(t, { cached = null, response = [], failure = null } = {}) {
	const serviceId = require.resolve("../dist/services/geo-cache.service.js");
	const prismaId = require.resolve("../dist/services/prisma.service.js");
	const axiosId = require.resolve("axios", { paths: [path.dirname(serviceId)] });
	const previous = new Map([serviceId, prismaId, axiosId].map(id => [id, require.cache[id]]));
	const reads = [], requests = [], writes = [];
	require.cache[prismaId] = { id: prismaId, filename: prismaId, loaded: true, exports: {
		prisma: { geoCache: {
			findUnique: async input => { reads.push(input); return cached; },
			upsert: async input => { writes.push(input); return input.create; },
		} },
	} };
	require.cache[axiosId] = { id: axiosId, filename: axiosId, loaded: true, exports: { __esModule: true, default: {
		get: async url => { requests.push(url); if (failure) throw failure; return { data: response }; },
	} } };
	delete require.cache[serviceId];
	const service = require(serviceId).default;
	t.after(() => {
		for (const [id, cachedModule] of previous) {
			if (cachedModule) require.cache[id] = cachedModule;
			else delete require.cache[id];
		}
	});
	return { service, reads, requests, writes };
}

test("a cold states cache calls IBGE with class context, maps/persists data and reuses memory", async t => {
	const h = loadService(t, { response: [{ sigla: "SC", nome: "Santa Catarina" }, { sigla: "AC", nome: "Acre" }] });
	const before = Date.now();
	const states = await h.service.getStates();
	assert.deepEqual(states, [{ code: "AC", name: "Acre" }, { code: "SC", name: "Santa Catarina" }]);
	assert.deepEqual(h.requests, ["https://servicodados.ibge.gov.br/api/v1/localidades/estados"]);
	assert.deepEqual(h.reads, [{ where: { key: "states" } }]);
	assert.equal(h.writes.length, 1);
	assert.equal(h.writes[0].create.key, "states");
	assert.deepEqual(h.writes[0].create.payload, [{ code: "SC", name: "Santa Catarina" }, { code: "AC", name: "Acre" }]);
	assert.ok(h.writes[0].create.expiresAt.getTime() >= before + 24 * 60 * 60 * 1000);
	assert.deepEqual(await h.service.getStates(), states);
	assert.equal(h.requests.length, 1);
	assert.equal(h.reads.length, 1);
});

test("fresh persisted states bypass IBGE and keep the cached array unchanged", async t => {
	const cached = { payload: [{ code: "SC", name: "Santa Catarina" }, { code: "AC", name: "Acre" }], expiresAt: new Date(Date.now() + 60000) };
	const h = loadService(t, { cached });
	assert.deepEqual(await h.service.getStates(), [{ code: "AC", name: "Acre" }, { code: "SC", name: "Santa Catarina" }]);
	assert.equal(cached.payload[0].code, "SC");
	assert.equal(h.requests.length, 0);
	assert.equal(h.writes.length, 0);
});

test("an actual upstream failure reuses stale persisted states after the correctly bound fetch", async t => {
	const h = loadService(t, { cached: { payload: [{ code: "AC", name: "Acre" }], expiresAt: new Date(Date.now() - 1000) }, failure: new Error("synthetic upstream unavailable") });
	assert.deepEqual(await h.service.getStates(), [{ code: "AC", name: "Acre" }]);
	assert.deepEqual(h.requests, ["https://servicodados.ibge.gov.br/api/v1/localidades/estados"]);
	assert.equal(h.writes.length, 0);
	await h.service.getStates();
	assert.equal(h.requests.length, 1);
});

test("cities retain their bound fetcher, normalized state and sorting", async t => {
	const h = loadService(t, { response: [{ nome: "Porto Alegre" }, { nome: "Canoas" }] });
	assert.deepEqual(await h.service.getCitiesByState(" rs "), ["Canoas", "Porto Alegre"]);
	assert.deepEqual(h.requests, ["https://servicodados.ibge.gov.br/api/v1/localidades/estados/RS/municipios"]);
	assert.equal(h.writes[0].create.key, "cities:RS");
});
