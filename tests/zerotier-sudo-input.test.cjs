const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { Writable } = require("node:stream");
const {
	createZeroTierDependencies,
	readZeroTierRecoveryConfig,
} = require("../dist/services/zerotier-recovery.service.js");

const passwordKey = "ZEROTIER_RECOVERY_SUDO_PASSWORD";
const password = " synthetic $p@ss ' \" ` # spaces ";

function settings() {
	return readZeroTierRecoveryConfig(
		{
			ZEROTIER_RECOVERY_ENABLED: "true",
			ZEROTIER_RECOVERY_USE_SUDO: "true",
			[passwordKey]: password,
		},
		"linux",
	);
}

test("the command executor sends the password once via stdin and excludes it from child arguments and environment", async (t) => {
	const previous = process.env[passwordKey];
	process.env[passwordKey] = password;
	t.after(() => {
		if (previous === undefined) delete process.env[passwordKey];
		else process.env[passwordKey] = previous;
	});
	const calls = [];
	t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
		const call = { file, args, options, input: "" };
		calls.push(call);
		const stdin = new Writable({
			write(chunk, _encoding, done) {
				call.input += chunk.toString();
				done();
			},
		});
		stdin.once("finish", () => {
			const output =
				args.at(-1) === "listnetworks"
					? '[{"id":"0123456789abcdef","status":"OK"}]'
					: '{"online":true}';
			callback(null, output, "");
		});
		return { stdin };
	});
	const config = settings();
	config.networkIds = ["0123456789abcdef"];
	const dependencies = createZeroTierDependencies(config, "linux");
	assert.deepEqual(await dependencies.check(), { healthy: true });
	await dependencies.restart();
	assert.equal(calls.length, 3);
	for (const call of calls) {
		assert.equal(call.file, "/usr/bin/sudo");
		assert.equal(call.input, `${password}\n`);
		assert.equal(call.options.env[passwordKey], undefined);
		assert.equal(call.options.env.PATH, process.env.PATH);
		assert.equal(call.options.windowsHide, true);
		assert.ok(!call.options.shell);
		assert.ok(!JSON.stringify(call.args).includes(password));
	}
	assert.equal(
		process.env[passwordKey],
		password,
		"only child environments are filtered",
	);
});

for (const outcome of [
	"success",
	"denied",
	"timeout",
	"stdin-error",
	"missing-sudo",
]) {
	test(`the command executor handles ${outcome} without leaking stdin or crashing on a closed pipe`, async (t) => {
		const capturedLogs = [];
		t.mock.method(console, "log", (...args) =>
			capturedLogs.push(args.join(" ")),
		);
		t.mock.method(
			childProcess,
			"execFile",
			(_file, _args, _options, callback) => {
				if (outcome === "missing-sudo") {
					setImmediate(() =>
						callback(
							Object.assign(new Error("spawn failed"), {
								code: "ENOENT",
							}),
							"",
							"",
						),
					);
					return { stdin: null };
				}
				const stdin = new Writable({
					write(_chunk, _encoding, done) {
						done(
							Object.assign(new Error("synthetic pipe error"), {
								code:
									outcome === "stdin-error" ? "EIO" : "EPIPE",
							}),
						);
					},
				});
				setImmediate(() => {
					if (outcome === "denied") {
						callback(
							Object.assign(new Error("command failed"), {
								code: 1,
							}),
							password,
							`sudo: incorrect password ${password}`,
						);
					} else if (outcome === "timeout") {
						callback(
							Object.assign(new Error("command timed out"), {
								killed: true,
							}),
							"",
							"",
						);
					} else {
						callback(null, '{"online":true}', "");
					}
				});
				return { stdin };
			},
		);
		const result = await createZeroTierDependencies(
			settings(),
			"linux",
		).check();
		if (outcome === "success") {
			assert.deepEqual(result, { healthy: true });
		} else {
			assert.equal(result.healthy, false);
			assert.equal(result.restartAllowed, false);
			assert.ok(!result.reason.includes(password));
			if (outcome === "missing-sudo")
				assert.match(result.reason, /sudo nao encontrado/);
		}
		assert.ok(capturedLogs.every((message) => !message.includes(password)));
	});
}
