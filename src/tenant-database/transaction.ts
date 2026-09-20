import { TenantDatabaseConfig } from "./config";
import { TenantConnection } from "./contracts";
import { deadline } from "./deadline";
import { TenantDatabaseError } from "./error";

export interface TenantTransaction {
	readonly tenant: string;
	/** Trusted repository SQL only. Await sequentially; paginate all potentially large reads. */
	execute<T = unknown>(
		statement: string,
		values?: readonly unknown[],
	): Promise<T>;
}

/** A connection never escapes this scope, including after a callback deadline. */
export async function runTenantTransaction<T>(
	connection: TenantConnection,
	tenant: string,
	tables: readonly string[],
	config: TenantDatabaseConfig,
	callback: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
	let open = true,
		busy = false,
		begun = false,
		committing = false,
		destroyed = false;
	let poisoned: TenantDatabaseError | undefined;
	let statements = 0,
		parameterBytes = 0;
	const destroy = () => {
		if (!destroyed) {
			destroyed = true;
			try {
				connection.destroy();
			} catch {
				/* Cleanup cannot change a known transaction outcome. */
			}
		}
	};
	const assertOpen = () => {
		if (!open) throw new TenantDatabaseError("TENANT_TRANSACTION_CLOSED");
		if (poisoned) throw poisoned;
	};
	const control = async (statement: string) => {
		assertOpen();
		await connection.control(statement);
		assertOpen();
	};
	const transaction: TenantTransaction = Object.freeze({
		tenant,
		execute<R = unknown>(
			statement: string,
			values: readonly unknown[] = [],
		): Promise<R> {
			const operation = (async () => {
				try {
					assertOpen();
					if (busy)
						throw new TenantDatabaseError(
							"TENANT_TRANSACTION_CONCURRENT_QUERY",
						);
					if (
						!/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(
							statement,
						) ||
						Buffer.byteLength(statement) > 65536
					)
						throw new TenantDatabaseError(
							"TENANT_TRANSACTION_SQL_NOT_ALLOWED",
						);
					if (++statements > config.maxStatements)
						throw new TenantDatabaseError(
							"TENANT_TRANSACTION_STATEMENT_LIMIT",
						);
					if (values.length > 10000)
						throw new TenantDatabaseError(
							"TENANT_TRANSACTION_PARAMETER_LIMIT",
						);
					const parameters = values.map((value) => {
						if (
							value === null ||
							typeof value === "boolean" ||
							(typeof value === "number" &&
								Number.isFinite(value))
						) {
							parameterBytes += 16;
							return value;
						}
						if (
							typeof value === "string" ||
							typeof value === "bigint"
						) {
							const text = String(value);
							parameterBytes += Buffer.byteLength(text);
							return text;
						}
						if (
							value instanceof Date &&
							Number.isFinite(value.getTime())
						) {
							parameterBytes += 32;
							return value;
						}
						if (Buffer.isBuffer(value)) {
							parameterBytes += value.length;
							return value;
						}
						throw new TenantDatabaseError(
							"TENANT_TRANSACTION_INVALID_PARAMETER",
						);
					});
					if (parameterBytes > config.maxParameterBytes)
						throw new TenantDatabaseError(
							"TENANT_TRANSACTION_BYTE_LIMIT",
						);
					busy = true;
					try {
						const result = await connection.execute(
							statement,
							parameters,
						);
						assertOpen();
						return result as R;
					} finally {
						busy = false;
					}
				} catch (error) {
					poisoned ??=
						error instanceof TenantDatabaseError
							? error
							: new TenantDatabaseError(
									"TENANT_TRANSACTION_QUERY_FAILED",
								);
					throw poisoned;
				}
			})();
			// A forgotten await still poisons the transaction without an unhandled rejection.
			void operation.catch(() => {});
			return operation;
		},
	});
	let timer: NodeJS.Timeout | undefined;
	try {
		const expired = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				open = false;
				destroy();
				reject(
					new TenantDatabaseError(
						committing
							? "TENANT_COMMIT_UNKNOWN"
							: "TENANT_TRANSACTION_TIMEOUT",
						committing ? "UNKNOWN" : "NOT_COMMITTED",
					),
				);
			}, config.transactionMs);
		});
		const work = async () => {
			await control("SET SESSION time_zone = '+00:00'");
			await control(
				"SET SESSION sql_mode = CONCAT_WS(',', @@SESSION.sql_mode, 'STRICT_ALL_TABLES')",
			);
			await control("SET SESSION innodb_lock_wait_timeout = 2");
			await control("START TRANSACTION");
			begun = true;
			// Hold metadata locks through COMMIT so engine/schema cannot change after validation.
			for (const table of tables) {
				assertOpen();
				await connection.execute(
					`SELECT 1 FROM \`${table}\` LIMIT 0`,
					[],
				);
			}
			assertOpen();
			const engines = (await connection.execute(
				`SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${tables.map(() => "?").join(",")})`,
				tables,
			)) as { name: string; engine: string }[];
			assertOpen();
			if (
				tables.some(
					(table) =>
						!engines.some(
							(row) =>
								row.name === table && row.engine === "InnoDB",
						),
				)
			)
				throw new TenantDatabaseError(
					"TENANT_TRANSACTION_REQUIRES_INNODB",
				);
			const value = await callback(transaction);
			assertOpen();
			if (busy) {
				destroy();
				throw new TenantDatabaseError(
					"TENANT_TRANSACTION_QUERY_NOT_AWAITED",
				);
			}
			committing = true;
			await control("COMMIT");
			return value;
		};
		return await Promise.race([work(), expired]);
	} catch (error) {
		open = false;
		if (committing) {
			destroy();
			throw new TenantDatabaseError("TENANT_COMMIT_UNKNOWN", "UNKNOWN");
		}
		if (busy) destroy();
		if (begun && !destroyed) {
			try {
				await deadline(
					connection.control("ROLLBACK"),
					Math.min(config.transactionMs, 1000),
					"TENANT_ROLLBACK_FAILED",
				);
			} catch {
				destroy();
			}
		} else destroy();
		throw error instanceof TenantDatabaseError
			? error
			: new TenantDatabaseError("TENANT_TRANSACTION_ABORTED");
	} finally {
		open = false;
		if (timer) clearTimeout(timer);
		if (!destroyed) {
			try {
				connection.release();
			} catch {
				destroy();
			}
		}
	}
}
