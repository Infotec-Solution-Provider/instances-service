const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
	parseFinishCommand,
	successorDate,
	nextLoyalty,
} = require("../dist/telephony-finish-v2/contract");
const op = "019a4af1-f83a-7001-8001-b53b920a3017";
test("calendar/actions preserve Delphi intervals and clamp month ends", () => {
	const now = "2026-11-13 10:00:00";
	for (const [action, next] of [
		[1, now],
		[3, "2026-11-13 10:20:00"],
		[9, "2026-11-28 10:00:00"],
		[14, "2026-11-14 10:00:00"],
		[20, "2026-11-17 10:00:00"],
		[6, null],
		[10, null],
	])
		assert.equal(successorDate(action, undefined, now), next);
	assert.equal(
		successorDate(4, undefined, "2026-01-31 10:00:00"),
		"2026-02-28 10:00:00",
	);
	assert.equal(
		successorDate(16, undefined, "2024-02-29 10:00:00"),
		"2025-02-28 10:00:00",
	);
	for (const action of [2, 7, 8]) {
		assert.throws(() => successorDate(action, undefined, now));
		assert.equal(
			successorDate(action, "2026-11-14 10:00:00", now),
			"2026-11-14 10:00:00",
		);
	}
	assert.throws(() => successorDate(17, undefined, now), /não é suportada/);
	assert.throws(
		() => successorDate(20, "2026-11-17 10:00:00", now),
		/não aceita data manual/,
	);
});
test("loyalty counter renews, decrements only contacts, records exhausted chain and leaves unrelated results untouched", () => {
	const base = {
		quantity: 3,
		previousId: 12,
		configured: 3,
		contact: true,
		resultLoyalty: false,
		scheduleLoyalty: true,
		zero: false,
	};
	assert.deepEqual(nextLoyalty(base), { quantity: 2, origin: 12 });
	assert.equal(nextLoyalty({ ...base, contact: false }), null);
	assert.equal(nextLoyalty({ ...base, scheduleLoyalty: false }), null);
	assert.deepEqual(nextLoyalty({ ...base, resultLoyalty: true }), {
		quantity: 3,
		origin: 0,
	});
	assert.deepEqual(
		nextLoyalty({ ...base, resultLoyalty: true, zero: true }),
		{ quantity: 2, origin: 12 },
	);
	assert.deepEqual(
		nextLoyalty({ ...base, resultLoyalty: true, zero: true, quantity: 0 }),
		{ quantity: 3, origin: 0 },
	);
	assert.deepEqual(nextLoyalty({ ...base, quantity: 1 }), {
		quantity: 0,
		origin: 12,
	});
	assert.equal(nextLoyalty({ ...base, quantity: 0 }), null);
});
test("typed command rejects cross-context fields and normalizes money, civil time and survey ordering", () => {
	const command = {
		operationId: op,
		resultId: 9,
		observation: "  Registro  ",
	};
	assert.throws(() => parseFinishCommand({ ...command, instance: "other" }));
	assert.throws(() =>
		parseFinishCommand({ ...command, sql: "DELETE FROM clientes" }),
	);
	assert.throws(() =>
		parseFinishCommand({ ...command, proposalValue: "10.001" }),
	);
	assert.throws(() =>
		parseFinishCommand({ ...command, scheduleDate: "2026-02-30T10:00" }),
	);
	assert.throws(() =>
		parseFinishCommand({
			...command,
			sale: {
				description: "Venda",
				value: "10",
				paymentMethod: "PIX",
				proposalIds: [1, 1],
			},
		}),
	);
	const parsed = parseFinishCommand({
		...command,
		proposalValue: "12.3",
		scheduleDate: "2026-11-14T10:30",
	});
	assert.equal(parsed.proposalValue, "12.30");
	assert.equal(parsed.observation, "Registro");
	assert.equal(parsed.scheduleDate, "2026-11-14 10:30:00");
	assert.deepEqual(
		parseFinishCommand(parsed),
		parsed,
		"canonical command survives signed transport parsing",
	);
});
