// Explicit test-only endpoints. Never accepts a host, database name or credentials.
module.exports = function isolatedMysqlPorts(variable, defaults) {
	const input = process.env[variable];
	if (input === undefined || input === "") return defaults;
	if (!/^\d+(?:,\d+){0,3}$/.test(input))
		throw new Error(`Invalid ${variable}`);
	const ports = input.split(",").map(Number);
	if (
		ports.some(
			(port) =>
				!Number.isInteger(port) ||
				port <= 1024 ||
				port >= 65536 ||
				port === 3306,
		) ||
		new Set(ports).size !== ports.length
	)
		throw new Error(`Invalid ${variable}`);
	return ports;
};
