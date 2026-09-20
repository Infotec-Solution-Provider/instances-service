import { TenantDatabaseConfig } from "./config";
import { TenantDatabaseError } from "./error";

interface Waiter {
	tenant: string;
	server: string;
	grant: () => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

/** Bounds queued work and skips saturated servers without blocking other tenants. */
export class TenantAdmission {
	private active = 0;
	private tenants = new Map<string, number>();
	private servers = new Map<string, number>();
	private waiting: Waiter[] = [];
	private closed = false;
	constructor(private readonly config: TenantDatabaseConfig) {}

	private available(tenant: string, server: string): boolean {
		return (
			this.active < this.config.activeGlobal &&
			(this.tenants.get(tenant) ?? 0) <
				this.config.connectionsPerTenant &&
			(this.servers.get(server) ?? 0) < this.config.activePerServer
		);
	}
	private take(tenant: string, server: string): () => void {
		this.active++;
		this.tenants.set(tenant, (this.tenants.get(tenant) ?? 0) + 1);
		this.servers.set(server, (this.servers.get(server) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			for (const [map, key] of [
				[this.tenants, tenant],
				[this.servers, server],
			] as const) {
				const next = (map.get(key) ?? 1) - 1;
				if (next) map.set(key, next);
				else map.delete(key);
			}
			this.drain();
		};
	}
	private drain(): void {
		for (const waiter of [...this.waiting]) {
			if (!this.available(waiter.tenant, waiter.server)) continue;
			this.waiting.splice(this.waiting.indexOf(waiter), 1);
			clearTimeout(waiter.timer);
			waiter.grant();
		}
	}
	public enter(tenant: string, server: string): Promise<() => void> {
		if (this.closed)
			return Promise.reject(
				new TenantDatabaseError("TENANT_DATABASE_CLOSED"),
			);
		if (this.available(tenant, server))
			return Promise.resolve(this.take(tenant, server));
		if (
			this.waiting.length >= this.config.pendingGlobal ||
			this.waiting.filter((item) => item.tenant === tenant).length >=
				this.config.pendingPerTenant ||
			this.waiting.filter((item) => item.server === server).length >=
				this.config.pendingPerServer
		) {
			return Promise.reject(
				new TenantDatabaseError("TENANT_DATABASE_BUSY"),
			);
		}
		return new Promise((resolve, reject) => {
			const waiter: Waiter = {
				tenant,
				server,
				reject,
				grant: () => resolve(this.take(tenant, server)),
				timer: setTimeout(() => {
					this.waiting.splice(this.waiting.indexOf(waiter), 1);
					reject(
						new TenantDatabaseError("TENANT_DATABASE_WAIT_TIMEOUT"),
					);
				}, this.config.waitMs),
			};
			this.waiting.push(waiter);
		});
	}
	public close(): void {
		this.closed = true;
		for (const waiter of this.waiting.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(new TenantDatabaseError("TENANT_DATABASE_CLOSED"));
		}
	}
	public snapshot() {
		return { active: this.active, pending: this.waiting.length };
	}
}
