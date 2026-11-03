import type { TenantDatabase } from "../tenant-database/tenant-database";
import { TenantDatabaseError } from "../tenant-database/error";
const fail = (code = "TENANT_ORDERING_INVALID"): never => {
	throw new TenantDatabaseError(code);
};
function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !keys.includes(key))
	)
		return fail();
	return value as Record<string, unknown>;
}
function name(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > 200 ||
		/[\u0000-\u001f\u007f-\u009f]/.test(value)
	)
		return fail();
	return value;
}
interface Link {
	cityId: number;
	expectedName: string;
	providerCity: string;
}
/** Coverage associations are additive and idempotent, separate from local-dialing exceptions. */
export async function associateDddCities(
	database: Pick<TenantDatabase, "transaction">,
	tenant: string,
	input: unknown,
) {
	const body = object(input, ["action", "ddd", "uf", "actorId", "links"]);
	if (
		body["action"] !== "phone-area-associate" ||
		typeof body["ddd"] !== "string" ||
		!/^[1-9]\d$/.test(body["ddd"]) ||
		typeof body["uf"] !== "string" ||
		!"AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO"
			.split(" ")
			.includes(body["uf"]) ||
		!Number.isSafeInteger(body["actorId"]) ||
		Number(body["actorId"]) < 1 ||
		!Array.isArray(body["links"]) ||
		body["links"].length < 1 ||
		body["links"].length > 1000
	)
		return fail();
	const ddd = body["ddd"],
		uf = body["uf"],
		actor = Number(body["actorId"]);
	const links: Link[] = body["links"].map((value) => {
		const link = object(value, ["cityId", "expectedName", "providerCity"]),
			cityId = Number(link["cityId"]);
		if (
			typeof link["cityId"] !== "number" ||
			!Number.isInteger(cityId) ||
			cityId < 1 ||
			cityId > 2147483647
		)
			return fail();
		return {
			cityId,
			expectedName: name(link["expectedName"]),
			providerCity: name(link["providerCity"]),
		};
	});
	if (
		new Set(links.map((link) => link.cityId)).size !== links.length ||
		new Set(links.map((link) => link.providerCity)).size !== links.length
	)
		return fail();
	links.sort((a, b) => a.cityId - b.cityId);
	return database.transaction(
		tenant,
		"crm.ddd-coverage.associate",
		["fone_areas", "cidades", "crm_ddd_city_links"],
		async (tx) => {
			const metadata = await tx.execute<
				{
					COLUMN_NAME: string;
					DATA_TYPE: string;
					CHARACTER_MAXIMUM_LENGTH: number | null;
					COLUMN_KEY: string;
				}[]
			>(
				"SELECT COLUMN_NAME,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='crm_ddd_city_links'",
				[],
			);
			const column = (key: string, type: string, length = 0) =>
				metadata.some(
					(row) =>
						row.COLUMN_NAME === key &&
						row.DATA_TYPE === type &&
						(!length ||
							Number(row.CHARACTER_MAXIMUM_LENGTH) >= length),
				);
			if (
				!column("ddd", "varchar", 2) ||
				!column("city_id", "int") ||
				!column("uf", "char", 2) ||
				!column("provider_city", "varchar", 200) ||
				!column("created_by", "int") ||
				!column("created_at", "datetime") ||
				metadata
					.filter((row) => row.COLUMN_KEY === "PRI")
					.map((row) => row.COLUMN_NAME)
					.sort()
					.join() !== "city_id,ddd"
			)
				return fail("TENANT_ORDERING_SCHEMA_UNAVAILABLE");
			const triggers = await tx.execute<unknown[]>(
				"SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='crm_ddd_city_links' LIMIT 1",
				[],
			);
			if (triggers.length)
				return fail("TENANT_TRANSACTION_UNREVIEWED_TRIGGERS");
			const areas = await tx.execute<{ CODIGO: string }[]>(
				"SELECT CODIGO FROM fone_areas WHERE CODIGO=? FOR UPDATE",
				[ddd],
			);
			if (areas.length !== 1 || areas[0]!.CODIGO !== ddd)
				return fail("TENANT_ORDERING_CHANGED");
			const cities = await tx.execute<
				{ CODIGO: number; NOME: string; UF: string }[]
			>(
				`SELECT CODIGO,NOME,UF FROM cidades WHERE CODIGO IN (${links.map(() => "?").join(",")}) ORDER BY CODIGO FOR UPDATE`,
				links.map((link) => link.cityId),
			);
			if (
				cities.length !== links.length ||
				links.some(
					(link) =>
						!cities.some(
							(city) =>
								city.CODIGO === link.cityId &&
								city.NOME === link.expectedName &&
								typeof city.UF === "string" &&
								city.UF.trim().toUpperCase() === uf,
						),
				)
			)
				return fail("TENANT_ORDERING_CHANGED");
			const previous = await tx.execute<
				{ city_id: number; uf: string }[]
			>(
				"SELECT city_id,uf FROM crm_ddd_city_links WHERE ddd=? ORDER BY city_id LIMIT 10001 FOR UPDATE",
				[ddd],
			);
			if (
				previous.length > 10000 ||
				previous.some((link) => link.uf !== uf)
			)
				return fail("TENANT_ORDERING_CHANGED");
			const pending = links.filter(
				(link) => !previous.some((old) => old.city_id === link.cityId),
			);
			if (pending.length) {
				const result = await tx.execute<{ affectedRows: number }>(
					`INSERT INTO crm_ddd_city_links (ddd,city_id,uf,provider_city,created_by) VALUES ${pending.map(() => "(?,?,?,?,?)").join(",")}`,
					pending.flatMap((link) => [
						ddd,
						link.cityId,
						uf,
						link.providerCity,
						actor,
					]),
				);
				if (result.affectedRows !== pending.length)
					return fail("TENANT_ORDERING_CHANGED");
			}
			return {
				added: pending.length,
				existing: links.length - pending.length,
			};
		},
	);
}
