import { createHash } from "node:crypto";
import { TenantDatabaseConfig } from "./config";
import { PoolFactory, TenantDestination, TenantPool } from "./contracts";
import { TenantDatabaseError } from "./error";
import { deadline } from "./deadline";

interface Entry {
	tenant: string;
	server: string;
	fingerprint: string;
	pool: TenantPool;
	users: number;
	lastUsed: number;
}

export function physicalServer(destination: TenantDestination): string {
	return (
		destination.serverGroup ??
		`${destination.host.trim().toLowerCase()}:${destination.port}`
	);
}

/** Pool slots reserve their full possible connection count, including idle sockets. */
export class TenantPoolRegistry {
	private entries = new Map<string, Entry>();
	private retiring = new Map<Entry, Promise<void>>();
	private timer: NodeJS.Timeout | undefined;
	private closed = false;
	constructor(
		private readonly config: TenantDatabaseConfig,
		private readonly factory: PoolFactory,
	) {}

	private retire(entry: Entry): Promise<void> {
		const pending = this.retiring.get(entry);
		if (pending) return pending;
		this.entries.delete(entry.tenant);
		// Closing entries still reserve capacity until end() acknowledges socket closure.
		const ending = Promise.resolve()
			.then(() => entry.pool.end())
			.then(() => {
				this.retiring.delete(entry);
			});
		this.retiring.set(entry, ending);
		return ending;
	}
	public async lease(
		destination: TenantDestination,
	): Promise<{ pool: TenantPool; release: () => void }> {
		const server = physicalServer(destination);
		const fingerprint = createHash("sha256")
			.update(JSON.stringify(destination))
			.digest("hex");
		for (;;) {
			if (this.closed)
				throw new TenantDatabaseError("TENANT_DATABASE_CLOSED");
			let entry = this.entries.get(destination.tenant);
			if (entry && entry.fingerprint !== fingerprint) {
				if (entry.users)
					throw new TenantDatabaseError("TENANT_DESTINATION_CHANGED");
				await this.retire(entry);
				continue;
			}
			if (!entry) {
				const all = [...this.entries.values(), ...this.retiring.keys()];
				const serverFull =
					all.filter((item) => item.server === server).length >=
					this.config.maxPoolsPerServer;
				if (all.length >= this.config.maxPools || serverFull) {
					const idle = [...this.entries.values()]
						.filter(
							(item) =>
								!item.users &&
								(!serverFull || item.server === server),
						)
						.sort((a, b) => a.lastUsed - b.lastUsed)[0];
					if (!idle)
						throw new TenantDatabaseError("TENANT_POOL_CAPACITY");
					await this.retire(idle);
					continue;
				}
				entry = {
					tenant: destination.tenant,
					server,
					fingerprint,
					pool: this.factory(
						destination,
						this.config.connectionsPerTenant,
						this.config.waitMs,
					),
					users: 0,
					lastUsed: Date.now(),
				};
				this.entries.set(destination.tenant, entry);
				if (!this.timer) {
					this.timer = setInterval(
						() => {
							void this.sweep().catch(() => {});
						},
						Math.min(this.config.idleMs, 30000),
					);
					this.timer.unref();
				}
			}
			entry.users++;
			let released = false;
			return {
				pool: entry.pool,
				release: () => {
					if (!released) {
						released = true;
						entry.users--;
						entry.lastUsed = Date.now();
					}
				},
			};
		}
	}
	public async sweep(now = Date.now()): Promise<void> {
		await Promise.all(
			[...this.entries.values()]
				.filter(
					(item) =>
						!item.users &&
						now - item.lastUsed >= this.config.idleMs,
				)
				.map((item) => this.retire(item)),
		);
	}
	public async close(): Promise<void> {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		await deadline(
			Promise.all(
				[...this.entries.values()]
					.map((item) => this.retire(item))
					.concat([...this.retiring.values()]),
			),
			this.config.waitMs,
			"TENANT_POOL_CLOSE_TIMEOUT",
		);
	}
	public snapshot() {
		return { pools: this.entries.size, closingPools: this.retiring.size };
	}
}
