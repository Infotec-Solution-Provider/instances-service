const test = require("node:test");
const assert = require("node:assert/strict");
const {
	ZeroTierRecoveryService,
	createZeroTierDependencies,
	readZeroTierRecoveryConfig,
	startZeroTierRecovery,
} = require("../dist/services/zerotier-recovery.service.js");

const NETWORK_A = "0123456789abcdef";
const NETWORK_B = "fedcba9876543210";
const unhealthy = {
	healthy: false,
	restartAllowed: true,
	reason: "ZeroTier OFFLINE",
};

function config(overrides = {}) {
	return {
		...readZeroTierRecoveryConfig(
			{ ZEROTIER_RECOVERY_ENABLED: "true" },
			"linux",
		),
		...overrides,
	};
}

function monitor(overrides = {}, dependencies = {}) {
	const calls = { checks: 0, restarts: 0, logs: [] };
	let now = 0;
	let health = unhealthy;
	const service = new ZeroTierRecoveryService(config(overrides), {
		check: async () => {
			calls.checks++;
			return health;
		},
		restart: async () => {
			calls.restarts++;
		},
		now: () => now,
		log: (message) => calls.logs.push(message),
		...dependencies,
	});
	return {
		service,
		calls,
		setNow: (value) => {
			now = value;
		},
		setHealth: (value) => {
			health = value;
		},
	};
}

async function checks(service, count) {
	for (let index = 0; index < count; index++) await service.checkNow();
}

function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function healthDependencies({
	info = { online: true },
	networks = [],
	targets = [],
	networkIds = [],
	probe,
} = {}) {
	const commands = [];
	const dependencies = createZeroTierDependencies(
		config({ networkIds, probeTargets: targets }),
		"linux",
		async (file, args, timeout) => {
			commands.push({ file, args, timeout });
			const command = args.at(-1);
			assert.ok(
				["info", "listnetworks"].includes(command),
				"health checks must not restart services",
			);
			return JSON.stringify(command === "info" ? info : networks);
		},
		probe ||
			(async () => {
				throw new Error("unexpected TCP probe");
			}),
	);
	return { dependencies, commands };
}

test("disabled monitor start and checkNow have no side effects", async () => {
	const { service, calls } = monitor({ enabled: false });
	service.start();
	service.start();
	await checks(service, 5);
	service.stop();
	assert.deepEqual(calls, { checks: 0, restarts: 0, logs: [] });
});

test("start is idempotent, respects startup grace and schedules the next round after completion", async (t) => {
	const timers = [];
	const cleared = [];
	t.mock.method(global, "setTimeout", (callback, delay) => {
		const timer = {
			callback,
			delay,
			unreferenced: false,
			unref() {
				this.unreferenced = true;
			},
		};
		timers.push(timer);
		return timer;
	});
	t.mock.method(global, "clearTimeout", (timer) => cleared.push(timer));
	const { service, calls } = monitor();
	service.start();
	service.start();
	assert.equal(calls.checks, 0);
	assert.equal(timers.length, 1);
	assert.equal(timers[0].delay, config().startupGraceMs);
	assert.equal(timers[0].unreferenced, true);
	await timers[0].callback();
	assert.equal(calls.checks, 1);
	assert.equal(timers.length, 2);
	assert.equal(timers[1].delay, config().intervalMs);
	service.stop();
	assert.deepEqual(cleared, [timers[1]]);
	await service.checkNow();
	assert.equal(calls.checks, 1);
});

test("a diagnostic from before stop/start cannot restart ZeroTier or create an extra timer", async (t) => {
	const timers = [];
	t.mock.method(global, "setTimeout", (callback, delay) => {
		const timer = { callback, delay, unref() {} };
		timers.push(timer);
		return timer;
	});
	t.mock.method(global, "clearTimeout", () => {});
	const checkGate = deferred();
	let checkCalls = 0;
	const { service, calls } = monitor(
		{ failureThreshold: 2 },
		{
			check: async () => {
				checkCalls++;
				return checkCalls === 2 ? checkGate.promise : unhealthy;
			},
		},
	);
	service.start();
	await timers[0].callback();
	const pending = timers[1].callback();
	service.stop();
	service.start();
	assert.equal(timers.length, 3);
	assert.equal(timers[2].delay, config().startupGraceMs);
	checkGate.resolve(unhealthy);
	await pending;
	assert.equal(
		calls.restarts,
		0,
		"a stale result must not count toward the failure threshold",
	);
	assert.equal(timers.length, 3, "only the new start may schedule a timer");
	service.stop();
});

test("stop during an unfinished diagnostic prevents restart and later checks until start", async () => {
	const checkGate = deferred();
	let checkCalls = 0;
	const { service, calls } = monitor(
		{ failureThreshold: 2 },
		{
			check: async () => {
				checkCalls++;
				return checkCalls === 2 ? checkGate.promise : unhealthy;
			},
		},
	);
	await service.checkNow();
	const pending = service.checkNow();
	service.stop();
	checkGate.resolve(unhealthy);
	await pending;
	await checks(service, 5);
	assert.equal(checkCalls, 2);
	assert.equal(calls.restarts, 0);
});

test("only consecutive failures reach the restart threshold and healthy checks reset it", async () => {
	const { service, calls, setHealth } = monitor();
	await checks(service, 2);
	assert.equal(calls.restarts, 0);
	setHealth({ healthy: true });
	await service.checkNow();
	setHealth(unhealthy);
	await checks(service, 2);
	assert.equal(calls.restarts, 0);
	await service.checkNow();
	assert.equal(calls.restarts, 1);
	assert.equal(
		calls.logs.filter((message) =>
			message.includes("conectividade verificada"),
		).length,
		1,
	);
	assert.ok(
		calls.logs.some((message) =>
			message.includes("aguardando verificacao de conectividade"),
		),
	);
	setHealth({ healthy: true });
	await service.checkNow();
	assert.equal(
		calls.logs.filter((message) =>
			message.includes("conectividade verificada"),
		).length,
		2,
	);
});

test("nonrecoverable diagnostics reset prior recoverable failures", async () => {
	const { service, calls, setHealth } = monitor();
	await checks(service, 2);
	setHealth({
		healthy: false,
		restartAllowed: false,
		reason: "network not authorized",
	});
	await checks(service, 4);
	setHealth(unhealthy);
	await checks(service, 2);
	assert.equal(calls.restarts, 0);
	await service.checkNow();
	assert.equal(calls.restarts, 1);
});

test("identical blocked diagnostics keep checking and repeat their log only once per minute regardless of restart cooldown", async () => {
	const { service, calls, setNow, setHealth } = monitor({ cooldownMs: 5000 });
	setHealth({
		healthy: false,
		restartAllowed: false,
		reason: "CLI unavailable",
	});
	const rounds = [
		[0, 1],
		[5000, 1],
		[10000, 1],
		[59999, 1],
		[60000, 2],
		[60000, 2],
		[119999, 2],
		[120000, 3],
	];
	for (const [now, expectedLogs] of rounds) {
		setNow(now);
		await service.checkNow();
		assert.equal(calls.logs.length, expectedLogs, `log count at ${now} ms`);
	}
	assert.equal(calls.checks, rounds.length);
	assert.equal(calls.restarts, 0);
	assert.ok(
		calls.logs.every((message) => message.includes("reinicio bloqueado")),
	);
});

test("changed blocks and recurring blocks after health transitions log immediately and recovery is announced once", async () => {
	const { service, calls, setHealth } = monitor();
	const blocked = {
		healthy: false,
		restartAllowed: false,
		reason: "CLI unavailable",
	};
	const blockedLogs = () =>
		calls.logs.filter((message) => message.includes("reinicio bloqueado"));
	setHealth(blocked);
	await checks(service, 2);
	assert.equal(blockedLogs().length, 1);
	setHealth({ ...blocked, reason: "sudo unavailable" });
	await service.checkNow();
	assert.equal(blockedLogs().length, 2);
	assert.match(blockedLogs().at(-1), /sudo unavailable/);
	setHealth({ healthy: true });
	await checks(service, 2);
	assert.equal(
		calls.logs.filter((message) =>
			message.includes("conectividade verificada"),
		).length,
		1,
	);
	setHealth({ ...blocked, reason: "sudo unavailable" });
	await service.checkNow();
	assert.equal(blockedLogs().length, 3);
	setHealth(unhealthy);
	await service.checkNow();
	setHealth({ ...blocked, reason: "sudo unavailable" });
	await service.checkNow();
	assert.equal(blockedLogs().length, 4);
	assert.equal(calls.restarts, 0);
});

test("a new start clears blocked log suppression while repeated start stays idempotent", async (t) => {
	t.mock.method(global, "setTimeout", () => ({ unref() {} }));
	t.mock.method(global, "clearTimeout", () => {});
	const { service, calls, setHealth } = monitor();
	t.after(() => service.stop());
	setHealth({
		healthy: false,
		restartAllowed: false,
		reason: "CLI unavailable",
	});
	const blockedLogs = () =>
		calls.logs.filter((message) => message.includes("reinicio bloqueado"));
	await service.checkNow();
	service.start();
	await service.checkNow();
	assert.equal(blockedLogs().length, 2);
	service.start();
	await service.checkNow();
	assert.equal(blockedLogs().length, 2);
	service.stop();
	service.start();
	await service.checkNow();
	assert.equal(blockedLogs().length, 3);
	assert.equal(calls.restarts, 0);
});

for (const restartFails of [false, true]) {
	test(`restart cooldown survives ${restartFails ? "a failed" : "a successful"} restart, including a first attempt at time zero`, async () => {
		let attempts = 0;
		const { service, calls, setNow, setHealth } = monitor(
			{},
			{
				restart: async () => {
					attempts++;
					if (restartFails) throw new Error("private command output");
				},
			},
		);
		await checks(service, 3);
		assert.equal(attempts, 1);
		setHealth({ healthy: true });
		await service.checkNow();
		setHealth(unhealthy);
		setNow(config().cooldownMs - 1);
		await checks(service, 5);
		assert.equal(
			attempts,
			1,
			"successful health checks must not clear restart cooldown",
		);
		setNow(config().cooldownMs);
		await service.checkNow();
		assert.equal(attempts, 2);
		assert.ok(
			calls.logs.every(
				(message) => !message.includes("private command output"),
			),
		);
		if (restartFails)
			assert.ok(
				calls.logs.some((message) =>
					message.includes("cooldown mantido"),
				),
			);
	});
}

test("concurrent checkNow calls cannot overlap checks or restarts", async () => {
	const checkGate = deferred();
	const restartGate = deferred();
	const restartStarted = deferred();
	let checkCalls = 0;
	let restartCalls = 0;
	const { service } = monitor(
		{ failureThreshold: 2 },
		{
			check: async () => {
				checkCalls++;
				return checkCalls === 2 ? checkGate.promise : unhealthy;
			},
			restart: async () => {
				restartCalls++;
				restartStarted.resolve();
				await restartGate.promise;
			},
		},
	);
	await service.checkNow();
	const pending = service.checkNow();
	await Promise.all([service.checkNow(), service.checkNow()]);
	assert.equal(checkCalls, 2);
	assert.equal(restartCalls, 0);
	checkGate.resolve(unhealthy);
	await restartStarted.promise;
	await service.checkNow();
	assert.equal(checkCalls, 2, "the lock must cover restart execution");
	assert.equal(restartCalls, 1);
	restartGate.resolve();
	await pending;
	await service.checkNow();
	assert.equal(checkCalls, 3, "the lock must be released after completion");
});

test("unexpected diagnostic exceptions reset failures and release the running lock without restart", async () => {
	let shouldThrow = false;
	const { service, calls } = monitor(
		{},
		{
			check: async () => {
				if (shouldThrow) throw new Error("secret diagnostic details");
				return unhealthy;
			},
		},
	);
	await checks(service, 2);
	shouldThrow = true;
	await assert.doesNotReject(service.checkNow());
	shouldThrow = false;
	await checks(service, 2);
	assert.equal(calls.restarts, 0);
	await service.checkNow();
	assert.equal(calls.restarts, 1);
	assert.ok(
		calls.logs.some((message) =>
			message.includes("nenhum reinicio solicitado"),
		),
	);
	assert.ok(
		calls.logs.every(
			(message) => !message.includes("secret diagnostic details"),
		),
	);
});

for (const [name, info, healthy, restartAllowed] of [
	["ONLINE", { online: true }, true],
	["TUNNELED", { online: false, tcpFallbackActive: true }, true],
	["OFFLINE", { online: false, tcpFallbackActive: false }, false, true],
	["OFFLINE without fallback field", { online: false }, false, true],
	["invalid online field", { online: "true" }, false, false],
	["null info", null, false, false],
]) {
	test(`CLI info ${name} is classified safely`, async () => {
		const { dependencies, commands } = healthDependencies({ info });
		const result = await dependencies.check();
		assert.equal(result.healthy, healthy);
		if (!healthy) assert.equal(result.restartAllowed, restartAllowed);
		assert.equal(commands.length, 1);
	});
}

for (const [name, error, restartAllowed, expectedReason, useSudo = false] of [
	["missing CLI", { code: "ENOENT" }, false, /CLI nao encontrada/],
	["missing sudo", { code: "ENOENT" }, false, /sudo nao encontrado/, true],
	[
		"executable access denied",
		{ code: "EACCES" },
		false,
		/sem permissao para executar/,
	],
	[
		"sudo executable access denied",
		{ code: "EACCES" },
		false,
		/sem permissao para executar/,
		true,
	],
	[
		"sudo cannot find the configured CLI",
		{
			stderr: "sudo: /private/zerotier-cli: command not found; confidential contents",
		},
		false,
		/CLI nao encontrada/,
		true,
	],
	[
		"missing authtoken",
		{ stderr: "authtoken.secret not found: confidential contents" },
		false,
		/autenticacao local/,
	],
	[
		"authentication denied",
		{ stderr: "authentication failed: confidential contents" },
		false,
		/autenticacao local/,
	],
	[
		"sudo needs password",
		{ stderr: "sudo: a password is required; confidential contents" },
		false,
		/sudo/,
		true,
	],
	[
		"sudo disallows the command",
		{
			stderr: "sudo: user is not allowed to execute; confidential contents",
		},
		false,
		/sudo/,
		true,
	],
	[
		"unrecognized sudo failure",
		{ stderr: "sudo: unexpected error; confidential contents" },
		false,
		/sudo/,
		true,
	],
	[
		"local token failure with sudo context",
		{
			stderr: "sudo: authtoken.secret permission denied; confidential contents",
		},
		false,
		/autenticacao local/,
		true,
	],
	[
		"permission failure with timeout",
		{ killed: true, stderr: "permission denied" },
		false,
		/permissao/,
	],
	[
		"access denied",
		{ stdout: "access denied; confidential contents" },
		false,
		/permissao/,
	],
	[
		"stdout auth error",
		{ stdout: "authtoken.secret missing: confidential contents" },
		false,
		/autenticacao local/,
	],
	[
		"stderr auth error plus stdout connection failure",
		{ stderr: "authentication denied", stdout: "connection refused" },
		false,
		/autenticacao local/,
	],
	[
		"unrecognized failure",
		{ code: 1, stderr: "confidential contents" },
		false,
	],
	["daemon command timeout", { killed: true }, true],
	[
		"daemon refused connection",
		{
			stderr: "Error connecting to the ZeroTier service: connection refused",
		},
		true,
	],
	[
		"daemon refused connection on stdout",
		{
			stdout: "Error connecting to the ZeroTier service: connection refused",
		},
		true,
	],
	["daemon connection timeout", { stderr: "connection timed out" }, true],
]) {
	test(`${name} ${restartAllowed ? "allows" : "blocks"} restart without exposing raw diagnostics`, async () => {
		const dependencies = createZeroTierDependencies(
			config({ useSudo }),
			"linux",
			async () => {
				throw error;
			},
		);
		const result = await dependencies.check();
		assert.equal(result.healthy, false);
		assert.equal(result.restartAllowed, restartAllowed);
		if (expectedReason) assert.match(result.reason, expectedReason);
		assert.ok(!result.reason.includes("confidential contents"));
	});
}

test("invalid JSON is a blocked diagnostic rather than evidence of a daemon outage", async () => {
	const dependencies = createZeroTierDependencies(
		config(),
		"linux",
		async () => "not JSON: confidential contents",
	);
	const result = await dependencies.check();
	assert.equal(result.healthy, false);
	assert.equal(result.restartAllowed, false);
	assert.ok(!result.reason.includes("confidential contents"));
});

for (const [name, networks, healthy, restartAllowed] of [
	["OK by id", [{ id: NETWORK_A, status: "OK" }], true],
	["OK by nwid", [{ nwid: NETWORK_A, status: "OK" }], true],
	[
		"ACCESS_DENIED",
		[{ id: NETWORK_A, status: "ACCESS_DENIED" }],
		false,
		false,
	],
	["missing membership", [], false, false],
	["unknown state", [{ id: NETWORK_A, status: "NEW_STATE" }], false, false],
	["invalid list response", {}, false, false],
	["PORT_ERROR", [{ id: NETWORK_A, status: "PORT_ERROR" }], false, true],
	[
		"REQUESTING_CONFIGURATION",
		[{ id: NETWORK_A, status: "REQUESTING_CONFIGURATION" }],
		false,
		true,
	],
]) {
	test(`configured network ${name} is classified safely`, async () => {
		const { dependencies, commands } = healthDependencies({
			networkIds: [NETWORK_A],
			networks,
		});
		const result = await dependencies.check();
		assert.equal(result.healthy, healthy);
		if (!healthy) assert.equal(result.restartAllowed, restartAllowed);
		assert.deepEqual(
			commands.map((command) => command.args.at(-1)),
			["info", "listnetworks"],
		);
	});
}

test("a nonrecoverable network takes priority over a recoverable network failure", async () => {
	for (const networkIds of [
		[NETWORK_A, NETWORK_B],
		[NETWORK_B, NETWORK_A],
	]) {
		const { dependencies } = healthDependencies({
			networkIds,
			networks: [
				{ id: NETWORK_A, status: "PORT_ERROR" },
				{ id: NETWORK_B, status: "ACCESS_DENIED" },
			],
		});
		assert.equal((await dependencies.check()).restartAllowed, false);
	}
});

test("OFFLINE info skips network and TCP probes", async () => {
	const { dependencies, commands } = healthDependencies({
		info: { online: false },
		networkIds: [NETWORK_A],
		targets: [
			{ host: "192.0.2.1", port: 3306 },
			{ host: "192.0.2.2", port: 3306 },
		],
	});
	assert.equal((await dependencies.check()).restartAllowed, true);
	assert.equal(commands.length, 1);
});

for (const accessibleHost of [undefined, "192.0.2.1", "192.0.2.2"]) {
	test(`TCP probes ${accessibleHost ? `accept one accessible host (${accessibleHost})` : "require all targets to fail before restarting"}`, async () => {
		const targets = [
			{ host: "192.0.2.1", port: 3306 },
			{ host: "192.0.2.2", port: 3307 },
		];
		const probed = [];
		const { dependencies } = healthDependencies({
			targets,
			probe: async (target) => {
				probed.push(target);
				return target.host === accessibleHost;
			},
		});
		const result = await dependencies.check();
		assert.deepEqual(probed, targets);
		assert.equal(result.healthy, Boolean(accessibleHost));
		if (!accessibleHost) assert.equal(result.restartAllowed, true);
	});
}

test("probe exceptions block restart rather than imply all destinations are down", async () => {
	const { dependencies } = healthDependencies({
		targets: [
			{ host: "192.0.2.1", port: 3306 },
			{ host: "192.0.2.2", port: 3306 },
		],
		probe: async () => {
			throw new Error("unexpected probe implementation error");
		},
	});
	assert.equal((await dependencies.check()).restartAllowed, false);
});

test("TCP probe dispatch preserves its default timeout rather than passing the array index", async () => {
	const timeouts = [];
	const { dependencies } = healthDependencies({
		targets: [
			{ host: "192.0.2.1", port: 3306 },
			{ host: "192.0.2.2", port: 3306 },
		],
		probe: async (_target, timeoutMs = 5000) => {
			timeouts.push(timeoutMs);
			return true;
		},
	});
	assert.deepEqual(await dependencies.check(), { healthy: true });
	assert.deepEqual(timeouts, [5000, 5000]);
});

test("configuration is opt-in and normalizes network IDs and IPv4, DNS and IPv6 targets", () => {
	assert.equal(readZeroTierRecoveryConfig({}, "linux").enabled, false);
	assert.equal(
		readZeroTierRecoveryConfig(
			{ ZEROTIER_RECOVERY_ENABLED: "TRUE" },
			"linux",
		).enabled,
		false,
	);
	const configured = readZeroTierRecoveryConfig(
		{
			ZEROTIER_RECOVERY_ENABLED: "true",
			ZEROTIER_RECOVERY_NETWORK_IDS: ` ${NETWORK_A.toUpperCase()}, ${NETWORK_B} `,
			ZEROTIER_RECOVERY_PROBE_TARGETS:
				"192.0.2.1:3306, database.internal:443, [2001:db8::1]:5432",
		},
		"linux",
	);
	assert.equal(configured.failureThreshold, 3);
	assert.equal(
		readZeroTierRecoveryConfig(
			{
				ZEROTIER_RECOVERY_ENABLED: "true",
				ZEROTIER_RECOVERY_COOLDOWN_MS: "5000",
			},
			"linux",
		).cooldownMs,
		5000,
	);
	assert.deepEqual(configured.networkIds, [NETWORK_A, NETWORK_B]);
	assert.deepEqual(configured.probeTargets, [
		{ host: "192.0.2.1", port: 3306 },
		{ host: "database.internal", port: 443 },
		{ host: "2001:db8::1", port: 5432 },
	]);
});

test("invalid enabled configuration rejects unsafe values and probes on only one distinct host", () => {
	const invalid = [
		["ZEROTIER_RECOVERY_INTERVAL_MS", "999"],
		["ZEROTIER_RECOVERY_INTERVAL_MS", "Infinity"],
		["ZEROTIER_RECOVERY_FAILURE_THRESHOLD", "1"],
		["ZEROTIER_RECOVERY_FAILURE_THRESHOLD", "2.5"],
		["ZEROTIER_RECOVERY_COOLDOWN_MS", "4999"],
		["ZEROTIER_RECOVERY_STARTUP_GRACE_MS", "-1"],
		["ZEROTIER_RECOVERY_COMMAND_TIMEOUT_MS", "not-a-number"],
		["ZEROTIER_RECOVERY_RESTART_TIMEOUT_MS", "2147483648"],
		["ZEROTIER_RECOVERY_NETWORK_IDS", "invalid-id"],
		["ZEROTIER_RECOVERY_PROBE_TARGETS", "192.0.2.1:3306"],
		["ZEROTIER_RECOVERY_PROBE_TARGETS", "DB.internal:3306,db.internal:443"],
		["ZEROTIER_RECOVERY_PROBE_TARGETS", "192.0.2.1:0,192.0.2.2:443"],
		["ZEROTIER_RECOVERY_PROBE_TARGETS", "192.0.2.1:65536,192.0.2.2:443"],
		["ZEROTIER_RECOVERY_PROBE_TARGETS", "192.0.2.1,192.0.2.2:443"],
	];
	for (const [key, value] of invalid) {
		assert.throws(
			() =>
				readZeroTierRecoveryConfig(
					{ ZEROTIER_RECOVERY_ENABLED: "true", [key]: value },
					"linux",
				),
			new RegExp(key),
			`${key}=${value}`,
		);
	}
	assert.throws(
		() =>
			readZeroTierRecoveryConfig(
				{ ZEROTIER_RECOVERY_ENABLED: "true" },
				"darwin",
			),
		/Linux.*Windows/,
	);
	assert.doesNotThrow(() =>
		readZeroTierRecoveryConfig(
			{ ZEROTIER_RECOVERY_PROBE_TARGETS: "invalid" },
			"darwin",
		),
	);
});

for (const useSudo of [false, true]) {
	test(`Linux commands use fixed service arguments${useSudo ? " and noninteractive sudo" : ""}`, async () => {
		const commandCalls = [];
		const settings = config({
			cliPath: "/opt/ZeroTier custom/zerotier-cli",
			useSudo,
			commandTimeoutMs: 4321,
			restartTimeoutMs: 8765,
		});
		const dependencies = createZeroTierDependencies(
			settings,
			"linux",
			async (file, args, timeout) => {
				commandCalls.push({ file, args, timeout });
				return JSON.stringify({ online: true });
			},
		);
		assert.deepEqual(await dependencies.check(), { healthy: true });
		await dependencies.restart();
		assert.deepEqual(
			commandCalls,
			useSudo
				? [
						{
							file: "/usr/bin/sudo",
							args: ["-n", settings.cliPath, "-j", "info"],
							timeout: 4321,
						},
						{
							file: "/usr/bin/sudo",
							args: [
								"-n",
								"/usr/bin/systemctl",
								"restart",
								"zerotier-one",
							],
							timeout: 8765,
						},
					]
				: [
						{
							file: settings.cliPath,
							args: ["-j", "info"],
							timeout: 4321,
						},
						{
							file: "/usr/bin/systemctl",
							args: ["restart", "zerotier-one"],
							timeout: 8765,
						},
					],
		);
	});
}

test("Windows CLI uses -q and restart uses the fixed ZeroTier service without incorporating custom CLI text", async () => {
	const commandCalls = [];
	const settings = config({
		cliPath: "C:\\custom; Write-Output injected\\zerotier.exe",
		useSudo: true,
	});
	const dependencies = createZeroTierDependencies(
		settings,
		"win32",
		async (file, args, timeout) => {
			commandCalls.push({ file, args, timeout });
			return JSON.stringify({ online: true });
		},
	);
	assert.deepEqual(await dependencies.check(), { healthy: true });
	await dependencies.restart();
	assert.deepEqual(commandCalls, [
		{
			file: settings.cliPath,
			args: ["-q", "-j", "info"],
			timeout: settings.commandTimeoutMs,
		},
		{
			file: "powershell.exe",
			args: [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"$ErrorActionPreference = 'Stop'; Restart-Service -Name 'ZeroTierOneService' -Force -ErrorAction Stop",
			],
			timeout: settings.restartTimeoutMs,
		},
	]);
});

function withEnvironment(values, run) {
	const previous = Object.fromEntries(
		Object.keys(values).map((key) => [key, process.env[key]]),
	);
	try {
		for (const [key, value] of Object.entries(values)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		return run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("entry point skips disabled and nonzero PM2 workers before validating configuration", () => {
	for (const values of [
		{ ZEROTIER_RECOVERY_ENABLED: undefined, NODE_APP_INSTANCE: "0" },
		{ ZEROTIER_RECOVERY_ENABLED: "false", NODE_APP_INSTANCE: "0" },
		{ ZEROTIER_RECOVERY_ENABLED: "true", NODE_APP_INSTANCE: "1" },
		{ ZEROTIER_RECOVERY_ENABLED: "true", NODE_APP_INSTANCE: "2" },
	]) {
		withEnvironment(
			{ ...values, ZEROTIER_RECOVERY_FAILURE_THRESHOLD: "invalid" },
			() => {
				assert.equal(startZeroTierRecovery(), undefined);
			},
		);
	}
});

test("entry point contains invalid configuration errors without breaking service startup", (t) => {
	const logged = [];
	t.mock.method(console, "error", (...args) => logged.push(args));
	withEnvironment(
		{
			ZEROTIER_RECOVERY_ENABLED: "true",
			NODE_APP_INSTANCE: "0",
			ZEROTIER_RECOVERY_FAILURE_THRESHOLD: "1",
		},
		() => {
			assert.equal(startZeroTierRecovery(), undefined);
		},
	);
	assert.equal(logged.length, 1);
	assert.match(logged[0].join(" "), /configuracao invalida/);
});
