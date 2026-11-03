const test = require("node:test"),
	assert = require("node:assert/strict"),
	ports = require("./isolated-mysql-ports.cjs");
test("fixture ports accept explicit loopback port lists without credential/host or SQL selectors", () => {
	const key = "INTEGRATION_TEST_MYSQL_PORTS";
	try {
		delete process.env[key];
		assert.deepEqual(ports(key, [13328, 13329]), [13328, 13329]);
		process.env[key] = "3308";
		assert.deepEqual(ports(key, []), [3308]);
		process.env[key] = "13328,13329";
		assert.deepEqual(ports(key, []), [13328, 13329]);
		for (const invalid of [
			"3306",
			"3308,3308",
			"0",
			"-1",
			"1e4",
			"65536",
			"3308,tenant",
			"host:3308",
			"3308;DROP",
			"3308, 3309",
		]) {
			process.env[key] = invalid;
			assert.throws(() => ports(key, []), /Invalid/);
		}
	} finally {
		delete process.env[key];
	}
});
