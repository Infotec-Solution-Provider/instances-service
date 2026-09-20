import { TenantAdmission } from "./admission";
import { TenantDatabaseConfig, tenantDatabaseConfig } from "./config";
import {
	DestinationResolver,
	PoolFactory,
	TenantDestination,
	TransactionDiagnostic,
} from "./contracts";
import { deadline } from "./deadline";
import { TenantDatabaseError } from "./error";
import { createTenantMysqlPool } from "./mysql-pool";
import { physicalServer, TenantPoolRegistry } from "./pool-registry";
import { runTenantTransaction, TenantTransaction } from "./transaction";

export class TenantDatabase {
	private readonly admission: TenantAdmission;
	private readonly pools: TenantPoolRegistry;
	private readonly inFlight = new Set<Promise<unknown>>();
	private readonly resolving = new Map<
		string,
		Promise<TenantDestination | null>
	>();
	private readonly outcomes = { committed: 0, notCommitted: 0, unknown: 0 };
	private closed = false;
	constructor(
		private readonly resolve: DestinationResolver,
		private readonly config: TenantDatabaseConfig = tenantDatabaseConfig(),
		factory: PoolFactory = createTenantMysqlPool,
		private readonly diagnostic: (
			event: TransactionDiagnostic,
		) => void = () => {},
	) {
		this.admission = new TenantAdmission(config);
		this.pools = new TenantPoolRegistry(config, factory);
	}

	private destination(tenant: string): Promise<TenantDestination | null> {
		const existing = this.resolving.get(tenant);
		if (existing) return existing;
		if (this.resolving.size >= this.config.pendingGlobal)
			throw new TenantDatabaseError("TENANT_DESTINATION_BUSY");
		const lookup = Promise.resolve().then(() => this.resolve(tenant));
		this.resolving.set(tenant, lookup);
		void lookup.then(
			() => this.resolving.delete(tenant),
			() => this.resolving.delete(tenant),
		);
		return lookup;
	}

	public transaction<T>(
		tenant: string,
		operation: string,
		tables: readonly string[],
		callback: (transaction: TenantTransaction) => Promise<T>,
	): Promise<T> {
		if (this.closed)
			return Promise.reject(
				new TenantDatabaseError("TENANT_DATABASE_CLOSED"),
			);
		if (
			!tenant ||
			tenant.length > 191 ||
			!/^[a-z][a-z0-9_.-]{0,63}$/i.test(operation) ||
			!tables.length ||
			tables.length > 32 ||
			tables.some((table) => !/^[a-z][a-z0-9_]{0,63}$/i.test(table))
		) {
			return Promise.reject(
				new TenantDatabaseError("TENANT_TRANSACTION_INVALID_CONTEXT"),
			);
		}
		// Includes destination lookups, so a stalled registry cannot accumulate unbounded requests.
		if (
			this.inFlight.size >=
			this.config.activeGlobal + this.config.pendingGlobal
		)
			return Promise.reject(
				new TenantDatabaseError("TENANT_DATABASE_BUSY"),
			);
		const work = this.run(
			tenant,
			operation,
			[...new Set(tables)],
			callback,
		);
		this.inFlight.add(work);
		void work.then(
			() => this.inFlight.delete(work),
			() => this.inFlight.delete(work),
		);
		return work;
	}
	private async run<T>(
		tenant: string,
		operation: string,
		tables: readonly string[],
		callback: (transaction: TenantTransaction) => Promise<T>,
	): Promise<T> {
		const started = Date.now();
		let leave: (() => void) | undefined;
		let lease: Awaited<ReturnType<TenantPoolRegistry["lease"]>> | undefined;
		let outcome: TransactionDiagnostic["outcome"] = "NOT_COMMITTED",
			code = "TENANT_DATABASE_FAILED";
		try {
			const destination = await deadline(
				this.destination(tenant),
				this.config.waitMs,
				"TENANT_DESTINATION_UNAVAILABLE",
			);
			if (
				!destination ||
				destination.tenant !== tenant ||
				!destination.database ||
				!destination.host ||
				!Number.isInteger(destination.port) ||
				destination.port < 1 ||
				destination.port > 65535
			)
				throw new TenantDatabaseError("TENANT_DESTINATION_INVALID");
			leave = await this.admission.enter(
				tenant,
				physicalServer(destination),
			);
			lease = await deadline(
				this.pools.lease(destination),
				this.config.waitMs,
				"TENANT_POOL_UNAVAILABLE",
				(late) => late.release(),
			);
			const connection = await deadline(
				lease.pool.acquire(),
				this.config.waitMs,
				"TENANT_CONNECTION_UNAVAILABLE",
				(late) => late.destroy(),
			);
			const result = await runTenantTransaction(
				connection,
				tenant,
				tables,
				this.config,
				callback,
			);
			outcome = "COMMITTED";
			code = "OK";
			return result;
		} catch (error) {
			const safe =
				error instanceof TenantDatabaseError
					? error
					: new TenantDatabaseError("TENANT_DATABASE_FAILED");
			outcome = safe.outcome;
			code = safe.code;
			throw safe;
		} finally {
			lease?.release();
			leave?.();
			if (outcome === "COMMITTED") this.outcomes.committed++;
			else if (outcome === "UNKNOWN") this.outcomes.unknown++;
			else this.outcomes.notCommitted++;
			try {
				this.diagnostic({
					tenant,
					operation,
					durationMs: Date.now() - started,
					outcome,
					code,
				});
			} catch {
				/* Observability must not change a committed result. */
			}
		}
	}
	public snapshot() {
		return {
			...this.admission.snapshot(),
			...this.pools.snapshot(),
			inFlight: this.inFlight.size,
			resolving: this.resolving.size,
			...this.outcomes,
		};
	}
	public async close(): Promise<void> {
		this.closed = true;
		this.admission.close();
		await Promise.allSettled([...this.inFlight]);
		await this.pools.close();
	}
}
