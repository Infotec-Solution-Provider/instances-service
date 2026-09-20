import mysql from "mysql2/promise";
import { PoolFactory } from "./contracts";

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
		charset: "utf8mb4_unicode_ci",
		timezone: "Z",
		dateStrings: true,
		supportBigNumbers: true,
		bigNumberStrings: true,
		multipleStatements: false,
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
			const connection = await pool.getConnection();
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
