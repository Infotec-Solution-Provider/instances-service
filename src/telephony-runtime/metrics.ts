import type { TenantTransaction } from "../tenant-database/transaction";
import { fail } from "./contract";

type Row = Record<string, unknown>;
export interface OperatorMetrics {
	serverNow: string;
	crmDay: string;
	conversationSeconds: number;
	attempts: number;
	pauseSeconds: number;
	productivePauseSeconds: number;
	connectedSeconds: number | null;
	contacts: number | null;
	closedOrders: number | null;
	closedOrderValue: string | null;
	productivityPercent: number | null;
	quotesToClose: number | null;
	scheduledCustomers: number | null;
	overdueSchedules: number | null;
	expectedSeconds: number | null;
	expectedSource: "campaign" | "receptive" | null;
	minimumConversationSeconds: number | null;
	incompleteCalls: number;
	visibility: { orders: boolean; productivity: boolean };
	availability: Record<string, boolean>;
}
const number = (value: unknown): number =>
	Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const timeSeconds = (value: unknown): number | null => {
	if (typeof value === "number") return Math.max(0, value);
	const match =
		typeof value === "string" ? /^(\d+):(\d\d):(\d\d)$/.exec(value) : null;
	return match
		? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
		: null;
};
/** Overlapping tabs and legacy/web intervals count once. Inputs are epoch seconds clipped by SQL. */
export function unionIntervalSeconds(
	rows: Array<{ start: unknown; end: unknown }>,
): number {
	const intervals = rows
		.map((row) => [Number(row.start), Number(row.end)] as const)
		.filter(
			([start, end]) =>
				Number.isFinite(start) && Number.isFinite(end) && end > start,
		)
		.sort((a, b) => a[0] - b[0]);
	let total = 0,
		from = 0,
		until = 0;
	for (const [start, end] of intervals) {
		if (start > until) {
			total += until - from;
			from = start;
			until = end;
		} else until = Math.max(until, end);
	}
	return Math.max(0, Math.floor(total + until - from));
}
export async function runtimeMetrics(
	tx: TenantTransaction,
	actorId: number,
): Promise<OperatorMetrics> {
	const clock = (
		await tx.execute<Row[]>(
			"SELECT DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-%dT%H:%i:%sZ') AS now,DATE_FORMAT(@inpulse_crm_transfer_at,'%Y-%m-%d') AS crmDay,TIMESTAMPDIFF(SECOND,@inpulse_crm_utc_at,@inpulse_crm_transfer_at) AS crmOffset",
			[],
		)
	)[0];
	if (!clock?.["crmDay"] || clock["crmOffset"] == null)
		return fail("CLOCK_UNAVAILABLE");
	const localStart = `${String(clock["crmDay"])} 00:00:00`,
		offset = Number(clock["crmOffset"]);
	const utcStart = new Date(
		Date.parse(`${String(clock["crmDay"])}T00:00:00Z`) - offset * 1000,
	)
		.toISOString()
		.slice(0, 19)
		.replace("T", " ");
	const utcEnd = new Date(
		Date.parse(`${String(clock["crmDay"])}T00:00:00Z`) -
			offset * 1000 +
			86_400_000,
	)
		.toISOString()
		.slice(0, 19)
		.replace("T", " ");
	const localEnd = new Date(
		Date.parse(`${String(clock["crmDay"])}T00:00:00Z`) + 86_400_000,
	)
		.toISOString()
		.slice(0, 19)
		.replace("T", " ");
	const columns = await tx.execute<
		{ TABLE_NAME: string; COLUMN_NAME: string }[]
	>(
		"SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('login_ativo_receptivo','telephony_web_sessions','campanhas_clientes','clientes','resultados','propostas','parametros','campanhas')",
		[],
	);
	const schema = new Set(
		columns.map(
			(column) =>
				`${column.TABLE_NAME.toLowerCase()}.${column.COLUMN_NAME.toUpperCase()}`,
		),
	);
	const has = (table: string, ...names: string[]) =>
		names.every((name) => schema.has(`${table}.${name.toUpperCase()}`));
	const calls =
		(
			await tx.execute<Row[]>(
				"SELECT COALESCE(SUM(IF(answered_at IS NOT NULL AND ended_at IS NOT NULL,GREATEST(0,TIMESTAMPDIFF(SECOND,GREATEST(answered_at,?),LEAST(ended_at,UTC_TIMESTAMP(),?))),0)),0) AS conversationSeconds,COALESCE(SUM(IF(COALESCE(sent_at,ringing_at,prepared_at)>=? AND COALESCE(sent_at,ringing_at,prepared_at)<?,1,0)),0) AS attempts,SUM(IF(ended_at IS NULL AND answered_at IS NOT NULL,1,0)) AS incompleteCalls FROM telephony_calls WHERE operator_id=? AND COALESCE(sent_at,ringing_at,prepared_at)<? AND (ended_at IS NULL OR ended_at>=?) AND (sent_at IS NOT NULL OR direction='incoming')",
				[utcStart, utcEnd, utcStart, utcEnd, actorId, utcEnd, utcStart],
			)
		)[0] || {};
	const pauses =
		(
			await tx.execute<Row[]>(
				"SELECT COALESCE(SUM(GREATEST(0,TIMESTAMPDIFF(SECOND,GREATEST(started_at,?),LEAST(COALESCE(ended_at,UTC_TIMESTAMP()),?)))),0) AS pauseSeconds,COALESCE(SUM(IF(productive=1,GREATEST(0,TIMESTAMPDIFF(SECOND,GREATEST(started_at,?),LEAST(COALESCE(ended_at,UTC_TIMESTAMP()),?,IF(max_seconds>0,DATE_ADD(started_at,INTERVAL max_seconds SECOND),COALESCE(ended_at,UTC_TIMESTAMP()))))),0)),0) AS productivePauseSeconds FROM telephony_pause_segments WHERE operator_id=? AND started_at<? AND (ended_at IS NULL OR ended_at>=?)",
				[utcStart, utcEnd, utcStart, utcEnd, actorId, utcEnd, utcStart],
			)
		)[0] || {};
	const result: OperatorMetrics = {
		serverNow: String(clock["now"]),
		crmDay: String(clock["crmDay"]),
		conversationSeconds: number(calls["conversationSeconds"]),
		attempts: number(calls["attempts"]),
		pauseSeconds: number(pauses["pauseSeconds"]),
		productivePauseSeconds: number(pauses["productivePauseSeconds"]),
		incompleteCalls: number(calls["incompleteCalls"]),
		connectedSeconds: null,
		contacts: null,
		closedOrders: null,
		closedOrderValue: null,
		productivityPercent: null,
		quotesToClose: null,
		scheduledCustomers: null,
		overdueSchedules: null,
		expectedSeconds: null,
		expectedSource: null,
		minimumConversationSeconds: null,
		visibility: { orders: false, productivity: false },
		availability: {},
	};
	const intervalRows: Array<{ start: unknown; end: unknown }> = [];
	const webAvailable = has(
		"telephony_web_sessions",
		"operator_id",
		"started_at",
		"last_seen",
	);
	let connectedComplete = webAvailable;
	if (webAvailable) {
		const rows = await tx.execute<Array<{ start: unknown; end: unknown }>>(
			"SELECT UNIX_TIMESTAMP(GREATEST(started_at,?)) AS start,UNIX_TIMESTAMP(LEAST(last_seen,?)) AS end FROM telephony_web_sessions WHERE operator_id=? AND started_at<? AND last_seen>=? LIMIT 1001",
			[utcStart, utcEnd, actorId, utcEnd, utcStart],
		);
		connectedComplete = rows.length <= 1000;
		intervalRows.push(...rows);
	}
	if (has("login_ativo_receptivo", "OPERADOR", "ENTRADA", "SAIDA")) {
		const rows = await tx.execute<Array<{ start: unknown; end: unknown }>>(
			"SELECT UNIX_TIMESTAMP(DATE_SUB(GREATEST(ENTRADA,?),INTERVAL ? SECOND)) AS start,UNIX_TIMESTAMP(DATE_SUB(LEAST(SAIDA,?),INTERVAL ? SECOND)) AS end FROM login_ativo_receptivo WHERE OPERADOR=? AND ENTRADA<? AND SAIDA>=? AND SAIDA>ENTRADA LIMIT 1001",
			[
				localStart,
				offset,
				localEnd,
				offset,
				actorId,
				localEnd,
				localStart,
			],
		);
		connectedComplete = connectedComplete && rows.length <= 1000;
		intervalRows.push(...rows);
	}
	result.connectedSeconds = connectedComplete
		? unionIntervalSeconds(intervalRows)
		: null;
	const paramNames = [
		"EXIBIR_PRODUTIVIDADE",
		"EXIBIR_PEDIDOS_FECHADOS",
		"TEMPO_MINIMO_CONVERSA",
		"TEMPO_MAX_RECEPTIVO",
	].filter((name) => has("parametros", name));
	const parameters = paramNames.length
		? (
				await tx.execute<Row[]>(
					`SELECT ${paramNames.map((name) => `\`${name}\``).join(",")} FROM parametros LIMIT 1`,
					[],
				)
			)[0] || {}
		: {};
	result.visibility.orders = parameters["EXIBIR_PEDIDOS_FECHADOS"] === "S";
	result.visibility.productivity = parameters["EXIBIR_PRODUTIVIDADE"] === "S";
	if (
		has("parametros", "TEMPO_MINIMO_CONVERSA") &&
		parameters["TEMPO_MINIMO_CONVERSA"] != null
	)
		result.minimumConversationSeconds = number(
			parameters["TEMPO_MINIMO_CONVERSA"],
		);
	const scheduleReady =
		has(
			"campanhas_clientes",
			"CODIGO",
			"CLIENTE",
			"OPERADOR",
			"CONCLUIDO",
			"DT_AGENDAMENTO",
		) && has("clientes", "CODIGO", "ATIVO");
	if (scheduleReady) {
		const row =
			(
				await tx.execute<Row[]>(
					"SELECT COUNT(DISTINCT cc.CLIENTE) AS scheduledCustomers,COALESCE(SUM(IF(cc.DT_AGENDAMENTO<@inpulse_crm_transfer_at,1,0)),0) AS overdueSchedules FROM campanhas_clientes cc INNER JOIN clientes c ON c.CODIGO=cc.CLIENTE WHERE cc.OPERADOR=? AND cc.CONCLUIDO='NAO' AND c.ATIVO='SIM' AND cc.DT_AGENDAMENTO>'1000-01-01'",
					[actorId],
				)
			)[0] || {};
		result.scheduledCustomers = number(row["scheduledCustomers"]);
		result.overdueSchedules = number(row["overdueSchedules"]);
	}
	const outcomeReady =
		has(
			"campanhas_clientes",
			"CODIGO",
			"RESULTADO",
			"OPERADOR_LIGACAO",
			"DT_RESULTADO",
		) && has("resultados", "CODIGO");
	if (outcomeReady && has("resultados", "ECONTATO")) {
		const row =
			(
				await tx.execute<Row[]>(
					"SELECT COUNT(*) AS contacts FROM campanhas_clientes cc INNER JOIN resultados r ON r.CODIGO=cc.RESULTADO WHERE cc.OPERADOR_LIGACAO=? AND cc.DT_RESULTADO>=? AND cc.DT_RESULTADO<? AND r.ECONTATO='SIM'",
					[actorId, localStart, localEnd],
				)
			)[0] || {};
		result.contacts = number(row["contacts"]);
	}
	if (
		result.visibility.orders &&
		outcomeReady &&
		has("resultados", "EPEDIDO") &&
		has("propostas", "CODIGO", "VALOR", "LIGACAO")
	) {
		const row =
			(
				await tx.execute<Row[]>(
					"SELECT COUNT(*) AS closedOrders,CAST(COALESCE(SUM(o.VALOR),0) AS CHAR) AS closedOrderValue FROM (SELECT DISTINCT p.CODIGO,p.VALOR FROM campanhas_clientes cc INNER JOIN resultados r ON r.CODIGO=cc.RESULTADO INNER JOIN propostas p ON p.LIGACAO=cc.CODIGO WHERE cc.OPERADOR_LIGACAO=? AND cc.DT_RESULTADO>=? AND cc.DT_RESULTADO<? AND r.EPEDIDO='SIM') o",
					[actorId, localStart, localEnd],
				)
			)[0] || {};
		result.closedOrders = number(row["closedOrders"]);
		result.closedOrderValue = String(row["closedOrderValue"] ?? "0");
	}
	if (
		outcomeReady &&
		has("campanhas_clientes", "CLIENTE", "DATA_HORA_LIG") &&
		has("resultados", "PROPOSTA", "EVENDA") &&
		has("clientes", "CODIGO", "ATIVO")
	) {
		const row =
			(
				await tx.execute<Row[]>(
					"SELECT COUNT(*) AS quotesToClose FROM (SELECT cc.CLIENTE,MAX(IF(r.PROPOSTA='SIM',cc.CODIGO,NULL)) AS proposal,MAX(IF(r.EVENDA='SIM',cc.CODIGO,NULL)) AS sale FROM campanhas_clientes cc INNER JOIN resultados r ON r.CODIGO=cc.RESULTADO INNER JOIN clientes c ON c.CODIGO=cc.CLIENTE AND c.ATIVO='SIM' WHERE cc.OPERADOR_LIGACAO=? AND cc.DATA_HORA_LIG>=DATE_SUB(@inpulse_crm_transfer_at,INTERVAL 30 DAY) AND cc.DATA_HORA_LIG<=@inpulse_crm_transfer_at GROUP BY cc.CLIENTE) q WHERE q.proposal>COALESCE(q.sale,0)",
					[actorId],
				)
			)[0] || {};
		result.quotesToClose = number(row["quotesToClose"]);
	}
	if (
		has("campanhas_clientes", "CODIGO", "CAMPANHA") &&
		has("campanhas", "CODIGO", "MAX_RESPOSTA")
	) {
		const row = (
			await tx.execute<Row[]>(
				"SELECT p.MAX_RESPOSTA FROM telephony_operator_state os INNER JOIN telephony_calls c ON c.id=os.active_call_id INNER JOIN campanhas_clientes cc ON cc.CODIGO=c.schedule_id INNER JOIN campanhas p ON p.CODIGO=cc.CAMPANHA WHERE os.operator_id=? AND c.ended_at IS NULL LIMIT 1",
				[actorId],
			)
		)[0];
		if (row?.["MAX_RESPOSTA"] != null) {
			result.expectedSeconds = number(row["MAX_RESPOSTA"]);
			result.expectedSource = "campaign";
		}
	}
	if (
		result.expectedSeconds === null &&
		parameters["TEMPO_MAX_RECEPTIVO"] != null
	) {
		result.expectedSeconds = timeSeconds(parameters["TEMPO_MAX_RECEPTIVO"]);
		result.expectedSource =
			result.expectedSeconds === null ? null : "receptive";
	}
	if (
		result.visibility.productivity &&
		result.connectedSeconds !== null &&
		result.connectedSeconds > 0
	)
		result.productivityPercent =
			Math.round(
				((result.conversationSeconds + result.productivePauseSeconds) /
					result.connectedSeconds) *
					100 *
					100,
			) / 100;
	for (const key of [
		"connectedSeconds",
		"contacts",
		"closedOrders",
		"closedOrderValue",
		"productivityPercent",
		"quotesToClose",
		"scheduledCustomers",
		"overdueSchedules",
		"expectedSeconds",
		"minimumConversationSeconds",
	] as const)
		result.availability[key] = result[key] !== null;
	return result;
}
