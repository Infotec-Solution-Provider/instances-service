export interface TenantDatabaseConfig {
	connectionsPerTenant: number;
	activeGlobal: number;
	activePerServer: number;
	pendingGlobal: number;
	pendingPerTenant: number;
	pendingPerServer: number;
	maxPools: number;
	maxPoolsPerServer: number;
	waitMs: number;
	transactionMs: number;
	idleMs: number;
	maxStatements: number;
	maxParameterBytes: number;
}

export function tenantDatabaseConfig(
	env: NodeJS.ProcessEnv = process.env,
): TenantDatabaseConfig {
	const number = (name: string, fallback: number, max: number): number => {
		const raw = env[`TENANT_DB_${name}`];
		if (raw === undefined || raw === "") return fallback;
		if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max)
			throw new Error(`Invalid TENANT_DB_${name}`);
		return Number(raw);
	};
	return {
		connectionsPerTenant: number("CONNECTIONS_PER_TENANT", 2, 10),
		activeGlobal: number("ACTIVE_GLOBAL", 16, 100),
		activePerServer: number("ACTIVE_PER_SERVER", 4, 50),
		pendingGlobal: number("PENDING_GLOBAL", 64, 1000),
		pendingPerTenant: number("PENDING_PER_TENANT", 8, 100),
		pendingPerServer: number("PENDING_PER_SERVER", 16, 500),
		maxPools: number("MAX_POOLS", 16, 100),
		maxPoolsPerServer: number("MAX_POOLS_PER_SERVER", 4, 50),
		waitMs: number("WAIT_MS", 2000, 30000),
		transactionMs: number("TRANSACTION_MS", 5000, 30000),
		idleMs: number("IDLE_MS", 60000, 3600000),
		maxStatements: number("MAX_STATEMENTS", 100, 1000),
		maxParameterBytes: number("MAX_PARAMETER_BYTES", 1048576, 16777216),
	};
}
