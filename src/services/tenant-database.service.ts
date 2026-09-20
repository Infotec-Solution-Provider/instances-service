import { TenantDatabase } from "../tenant-database/tenant-database";
import ServersService from "./servers.service";

/** Lazy: no pool or connection is opened until a migrated repository invokes it. */
let database: TenantDatabase | undefined;
export function getTenantDatabase(): TenantDatabase {
	return (database ??= new TenantDatabase(
		async (tenant) => {
			const server = await ServersService.get(tenant);
			if (!server || server.instanceName !== tenant) return null;
			return {
				tenant,
				host: server.host,
				port: server.port,
				user: server.username,
				password: server.password,
				database: server.database,
			};
		},
		undefined,
		undefined,
		(event) => {
			if (event.outcome !== "COMMITTED")
				console.warn(
					JSON.stringify({
						component: "tenant-transaction",
						...event,
					}),
				);
		},
	));
}

export async function closeTenantDatabase(): Promise<void> {
	await database?.close();
}
