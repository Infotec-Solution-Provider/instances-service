/** Resolved by trusted server code; never accept a database address from an HTTP payload. */
export interface TenantDestination {
	tenant: string;
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
	/** Stable physical-server group when several addresses refer to the same server. */
	serverGroup?: string;
	tls?: { ca?: string };
}

export interface TenantConnection {
	control(statement: string): Promise<void>;
	execute(statement: string, values: readonly unknown[]): Promise<unknown>;
	release(): void;
	destroy(): void;
}

export interface TenantPool {
	acquire(): Promise<TenantConnection>;
	end(): Promise<void>;
}

export type DestinationResolver = (
	tenant: string,
) => Promise<TenantDestination | null>;
export type PoolFactory = (
	destination: TenantDestination,
	connections: number,
	timeoutMs: number,
) => TenantPool;
export type TransactionOutcome = "NOT_COMMITTED" | "UNKNOWN";

export interface TransactionDiagnostic {
	tenant: string;
	operation: string;
	durationMs: number;
	outcome: "COMMITTED" | TransactionOutcome;
	code: string;
}
