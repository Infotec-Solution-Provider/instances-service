import mysql from "mysql2/promise";
import { PoolFactory } from "./contracts";

const connectionErrorCodes = new Set([
	"ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN",
	"ER_ACCESS_DENIED_ERROR", "ER_HOST_NOT_PRIVILEGED", "ER_BAD_DB_ERROR", "ER_CON_COUNT_ERROR",
	"ER_TOO_MANY_USER_CONNECTIONS", "ER_NOT_SUPPORTED_AUTH_MODE", "AUTH_SWITCH_PLUGIN_ERROR",
	"PROTOCOL_CONNECTION_LOST", "ER_UNKNOWN_CHARACTER_SET", "ER_UNKNOWN_COLLATION", "HANDSHAKE_SSL_ERROR",
	"PROTOCOL_PACKETS_OUT_OF_ORDER", "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR", "PROTOCOL_SEQUENCE_TIMEOUT",
]);
/** Never expose driver messages, causes, SQL, parameters or connection options. */
export function tenantConnectionErrorCode(error: unknown): string {
	try {
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
		return typeof code === "string" && connectionErrorCodes.has(code) ? code : "UNCLASSIFIED";
	} catch { return "UNCLASSIFIED"; }
}

export const createTenantMysqlPool: PoolFactory = (
	destination,
	connections,
	timeoutMs,
) => {
	const pool = mysql.createPool({
		host: destination.host,
		port: destination.port,
		user: destination.user,
		password: destination.password,
		database: destination.database,
		charset: destination.charset ?? "utf8mb4_unicode_ci",
		timezone: "Z",
		dateStrings: true,
		supportBigNumbers: true,
		bigNumberStrings: true,
		multipleStatements: false,
		// CAS expects matched rows, including an unchanged intermediate batch flag.
		flags: ["FOUND_ROWS"],
		waitForConnections: false,
		connectionLimit: connections,
		connectTimeout: timeoutMs,
		maxIdle: 0,
		idleTimeout: 1000,
		maxPreparedStatements: 50,
		...(destination.tls
			? { ssl: { ...destination.tls, rejectUnauthorized: true } }
			: {}),
	});
	return {
		async acquire() {
			const started = Date.now();
			const connection = await pool.getConnection().catch((error: unknown) => {
				try { console.warn(JSON.stringify({ component: "tenant-connection", phase: "acquire", tenant: destination.tenant, elapsedMs: Date.now() - started, errorCode: tenantConnectionErrorCode(error) })); }
				catch { /* Diagnostics cannot replace the actual connection failure. */ }
				throw error;
			});
			return {
				async control(statement) {
					await connection.query(statement);
				},
				async execute(statement, values) {
					const [rows] = await connection.execute(statement, [
						...values,
					]);
					return rows;
				},
				release: () => connection.release(),
				destroy: () => connection.destroy(),
			};
		},
		end: () => pool.end(),
	};
};
