import { runtimeMetrics } from "./metrics";
export { runtimeMetrics } from "./metrics";
import { createHash } from "node:crypto";
import { handleWebSession } from "./web-session";
import { pauseCutoffAvailable, pauseCutoffColumn, pausePolicyScope, semanticPauseInput } from "./operator-pause";
import type { TenantTransaction } from "../tenant-database/transaction";
import type { TenantDatabase } from "../tenant-database/tenant-database";
import {
	fail,
	integer,
	text,
	uuid,
	databaseId,
	runtimeTables,
	type RuntimeCommand,
} from "./contract";

type Row = Record<string, any>;
const canonical = (value: unknown): string =>
	value && typeof value === "object"
		? Array.isArray(value)
			? `[${value.map(canonical).join(",")}]`
			: `{${Object.keys(value as Row)
					.sort()
					.map(
						(key) =>
							`${JSON.stringify(key)}:${canonical((value as Row)[key])}`,
					)
					.join(",")}}`
		: JSON.stringify(value);
const hash = (value: unknown) =>
	createHash("sha256").update(canonical(value)).digest("hex");
const iso = (value: any): string | null =>
	value == null
		? null
		: value instanceof Date
			? value.toISOString()
			: new Date(
					String(value).replace(" ", "T") +
						(/Z$|[+-]\d\d:\d\d$/.test(String(value)) ? "" : "Z"),
				).toISOString();
export async function actor(tx: TenantTransaction, id: number) {
	const rows = await tx.execute<Row[]>(
		"SELECT CODIGO,NIVEL,ATIVO FROM operadores WHERE CODIGO=?",
		[id],
	);
	if (!rows.length || rows[0]!["ATIVO"] !== "SIM") return fail("FORBIDDEN");
	return rows[0]!;
}
async function lockState(tx: TenantTransaction, id: number) {
	await tx.execute(
		"INSERT INTO telephony_operator_state (operator_id) VALUES (?) ON DUPLICATE KEY UPDATE operator_id=VALUES(operator_id)",
		[id],
	);
	return (
		await tx.execute<Row[]>(
			"SELECT * FROM telephony_operator_state WHERE operator_id=? FOR UPDATE",
			[id],
		)
	)[0]!;
}
export const lockTelephonyOperator = lockState;
async function clock(tx: TenantTransaction) {
	return (await tx.execute<Row[]>("SELECT UTC_TIMESTAMP() AS now", []))[0]![
		"now"
	];
}
async function unavailableClock(tx: TenantTransaction) {
	// Fractional syntax is unsupported by MySQL 5.5. The additive column's
	// actual type proves support before using a separate millisecond clock.
	const column = await pauseCutoffColumn(tx);
	return (await tx.execute<Row[]>(column.fractional ? "SELECT UTC_TIMESTAMP(3) AS now" : "SELECT UTC_TIMESTAMP() AS now", []))[0]!["now"];
}
async function receipt(
	tx: TenantTransaction,
	actorId: number,
	operationId: string,
	kind: string,
	input: unknown,
): Promise<Row | null> {
	const digest = hash({ actorId, kind, input });
	const rows = await tx.execute<Row[]>(
		"SELECT actor_id,request_hash,result_json FROM telephony_runtime_operations WHERE operation_id=? FOR UPDATE",
		[operationId],
	);
	if (rows.length) {
		if (
			Number(rows[0]!["actor_id"]) !== actorId ||
			rows[0]!["request_hash"] !== digest
		)
			return fail("OPERATION_REUSED");
		return JSON.parse(rows[0]!["result_json"]);
	}
	return null;
}
async function saveReceipt(
	tx: TenantTransaction,
	actorId: number,
	operationId: string,
	kind: string,
	input: unknown,
	result: unknown,
) {
	await tx.execute(
		"INSERT INTO telephony_runtime_operations (operation_id,actor_id,kind,request_hash,result_json,created_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP())",
		[
			operationId,
			actorId,
			kind,
			hash({ actorId, kind, input }),
			JSON.stringify(result),
		],
	);
}
async function canChangeReason(tx: TenantTransaction, fallback: unknown) {
	const column = await tx.execute<Row[]>(
		"SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='parametros' AND COLUMN_NAME='PERMITE_ALTERAR_PAUSA'",
		[],
	);
	if (!column.length) return Number(fallback) === 1;
	const parameters = await tx.execute<Row[]>(
		"SELECT PERMITE_ALTERAR_PAUSA FROM parametros ORDER BY CODIGO LIMIT 2",
		[],
	);
	if (parameters.length !== 1) return false;
	return ["S", "SIM", "T", "1"].includes(
		String(parameters[0]!["PERMITE_ALTERAR_PAUSA"]),
	);
}
async function stateView(tx: TenantTransaction, id: number) {
	const states = await tx.execute<Row[]>(
		"SELECT * FROM telephony_operator_state WHERE operator_id=?",
		[id],
	);
	const state = states[0];
	const segments = state?.["pause_id"]
		? await tx.execute<Row[]>(
				"SELECT * FROM telephony_pause_segments WHERE id=? AND operator_id=?",
				[state["pause_id"], id],
			)
		: [];
	const pending = await tx.execute<Row[]>(
		"SELECT p.status,p.detail FROM telephony_pbx_intents p WHERE p.operator_id=? AND NOT EXISTS (SELECT 1 FROM telephony_pbx_intents newer WHERE newer.operator_id=p.operator_id AND newer.queue_name=p.queue_name AND newer.member_interface=p.member_interface AND newer.id>p.id) ORDER BY FIELD(p.status,'failed','unknown','pending','confirmed'),p.id DESC LIMIT 1",
		[id],
	);
	const reasons = await tx.execute<Row[]>(
		"SELECT CODIGO AS id,DESCRICAO AS name,TEMPO_MAX_SEG AS maxSeconds,PRODUTIVIDADE AS productive FROM motivos_pausa ORDER BY DESCRICAO LIMIT 200",
		[],
	);
	const segment = segments[0];
	const policy = (
		await tx.execute<Row[]>(
			"SELECT * FROM telephony_runtime_policy WHERE id=1 LOCK IN SHARE MODE",
			[],
		)
	)[0];
	return {
		enabled: true,
		...pausePolicyScope(policy, Number(policy?.["pause_all_channels"]) === 1 && await pauseCutoffAvailable(tx)),
		allowChangeReason: await canChangeReason(
			tx,
			policy?.["allow_change_reason"],
		),
		state: state?.["state"] || "available",
		version: Number(state?.["version"] || 0),
		activeCallId: state?.["active_call_id"] || null,
		pendingScheduleId: state?.["pending_schedule_id"] || null,
		reasonId:
			state?.["reason_id"] == null ? null : Number(state["reason_id"]),
		pauseId: state?.["pause_id"] == null ? null : Number(state["pause_id"]),
		startedAt: iso(segment?.["started_at"]),
		unavailableSince: iso(state?.["unavailable_since"]),
		maxSeconds: Number(segment?.["max_seconds"] || 0),
		reason: segment?.["reason_name"] || null,
		reasons,
		pbx: pending[0] || { status: "not_configured", detail: null },
		serverNow: iso(await clock(tx)),
	};
}
async function enqueuePbx(
	tx: TenantTransaction,
	actorId: number,
	desired: boolean,
	operationId: string,
) {
	const mappings = await tx.execute<Row[]>(
		"SELECT queue_name,member_interface FROM telephony_pbx_members WHERE operator_id=? AND enabled=1 ORDER BY queue_name,member_interface FOR UPDATE",
		[actorId],
	);
	for (const mapping of mappings) {
		await tx.execute(
			"UPDATE telephony_pbx_intents SET status='superseded',updated_at=UTC_TIMESTAMP() WHERE operator_id=? AND queue_name=? AND member_interface=? AND status IN ('pending','unknown')",
			[actorId, mapping["queue_name"], mapping["member_interface"]],
		);
		await tx.execute(
			"INSERT INTO telephony_pbx_intents (operation_id,operator_id,queue_name,member_interface,paused,status,created_at) VALUES (?,?,?,?,?,'pending',UTC_TIMESTAMP())",
			[
				operationId,
				actorId,
				mapping["queue_name"],
				mapping["member_interface"],
				desired ? 1 : 0,
			],
		);
	}
}
async function closePause(tx: TenantTransaction, state: Row, at: any) {
	if (state["pause_id"]) {
		const current = (
			await tx.execute<Row[]>(
				"SELECT started_at FROM telephony_pause_segments WHERE id=? FOR UPDATE",
				[state["pause_id"]],
			)
		)[0];
		if (
			!current ||
			Date.parse(iso(at)!) < Date.parse(iso(current["started_at"])!)
		)
			return fail("INVALID_REQUEST");
	}
	if (state["pause_id"])
		await tx.execute(
			"UPDATE telephony_pause_segments SET ended_at=?,duration_seconds=GREATEST(0,TIMESTAMPDIFF(SECOND,started_at,?)),exceeded_seconds=IF(max_seconds>0,GREATEST(0,TIMESTAMPDIFF(SECOND,started_at,?)-max_seconds),0) WHERE id=? AND operator_id=? AND ended_at IS NULL",
			[at, at, at, state["pause_id"], state["operator_id"]],
		);
}
async function beginPause(
	tx: TenantTransaction,
	state: Row,
	reasonId: number,
	at: any,
	operationId: string,
) {
	const rows = await tx.execute<Row[]>(
		"SELECT CODIGO,DESCRICAO,TEMPO_MAX_SEG,PRODUTIVIDADE FROM motivos_pausa WHERE CODIGO=? FOR UPDATE",
		[reasonId],
	);
	if (!rows.length) return fail("REASON_UNAVAILABLE");
	const reason = rows[0]!;
	const inserted = await tx.execute<Row>(
		"INSERT INTO telephony_pause_segments (operator_id,reason_id,reason_name,max_seconds,productive,started_at,operation_id) VALUES (?,?,?,?,?,?,?)",
		[
			state["operator_id"],
			reasonId,
			reason["DESCRICAO"],
			Math.max(0, Number(reason["TEMPO_MAX_SEG"]) || 0),
			["SIM", "S", "T", "1"].includes(String(reason["PRODUTIVIDADE"]))
				? 1
				: 0,
			at,
			operationId,
		],
	);
	const cutoff = Object.hasOwn(state, "unavailable_since")
		? state["state"] === "available" ? await unavailableClock(tx) : state["unavailable_since"]
		: null;
	await tx.execute(
		`UPDATE telephony_operator_state SET state='paused',reason_id=?,pause_id=?,pending_schedule_id=NULL,active_call_id=NULL${Object.hasOwn(state, "unavailable_since") ? ",unavailable_since=?" : ""},version=version+1,updated_at=UTC_TIMESTAMP() WHERE operator_id=?`,
		[reasonId, inserted["insertId"], ...(Object.hasOwn(state, "unavailable_since") ? [cutoff] : []), state["operator_id"]],
	);
	await enqueuePbx(tx, state["operator_id"], true, operationId);
}
function observed(value: unknown, now: any): string {
	const raw = text(value, 40);
	if (
		!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(
			raw,
		) ||
		!Number.isFinite(Date.parse(raw)) ||
		Date.parse(raw) > new Date(iso(now)!).getTime() + 300_000
	)
		return fail("INVALID_REQUEST");
	return new Date(raw).toISOString().slice(0, 19).replace("T", " ");
}
function callView(row: Row) {
	return {
		callId: row["id"],
		direction: row["direction"],
		number: row["number"],
		extension: row["extension"],
		operatorId: Number(row["operator_id"]),
		scheduleId:
			row["schedule_id"] == null ? null : Number(row["schedule_id"]),
		customerId:
			row["customer_id"] == null ? null : Number(row["customer_id"]),
		state: row["state"],
		preparedAt: iso(row["prepared_at"]),
		sentAt: iso(row["sent_at"]),
		ringingAt: iso(row["ringing_at"]),
		answeredAt: iso(row["answered_at"]),
		endedAt: iso(row["ended_at"]),
		observedUntil: iso(row["updated_at"]),
		rating: row["rating"] ?? null,
		comment: row["comment"] ?? "",
		reviewVersion: Number(row["review_version"] || 0),
	};
}

export async function executeRuntime(
	tx: TenantTransaction,
	command: RuntimeCommand,
): Promise<any> {
	const user = await actor(tx, command.actorId),
		{ action, input, actorId } = command;
	const policy = (
		await tx.execute<Row[]>(
			"SELECT * FROM telephony_runtime_policy WHERE id=1 LOCK IN SHARE MODE",
			[],
		)
	)[0];
	if (!policy?.["enabled"]) return fail("DISABLED");
	if (!/^[a-f0-9]{64}$/i.test(String(policy["preflight_hash"] || "")))
		return fail("PREFLIGHT_REQUIRED");
	if (action === "status") return stateView(tx, actorId);
	if (action === "session") {
		await lockState(tx, actorId);
		return handleWebSession(tx, actorId, input);
	}
	if (action === "prepare") {
		const callId = uuid(input["callId"]),
			direction = input["direction"];
		if (!["incoming", "outgoing"].includes(String(direction)))
			return fail("INVALID_REQUEST");
		const number = text(input["number"], 64),
			scheduleId = integer(input["scheduleId"], true);
		if (direction === "outgoing" && !/^\+?[0-9*#]{1,32}$/.test(number))
			return fail("INVALID_REQUEST");
		const state = await lockState(tx, actorId);
		const existing = await tx.execute<Row[]>(
			"SELECT * FROM telephony_calls WHERE id=? FOR UPDATE",
			[callId],
		);
		if (existing.length) {
			if (
				Number(existing[0]!["operator_id"]) !== actorId ||
				existing[0]!["direction"] !== direction ||
				existing[0]!["number"] !== number ||
				(existing[0]!["schedule_id"] == null
					? null
					: Number(existing[0]!["schedule_id"])) !== scheduleId
			)
				return fail("OPERATION_REUSED");
			return callView(existing[0]!);
		}
		if (
			direction === "outgoing" &&
			state["state"] !== "available" &&
			!(
				state["state"] === "pending" &&
				scheduleId &&
				Number(state["pending_schedule_id"]) === scheduleId
			)
		)
			return fail("PAUSED");
		if (direction === "outgoing" && state["active_call_id"])
			return fail("CALL_ACTIVE");
		let customerId: number | null = null;
		if (scheduleId) {
			const hint = (
				await tx.execute<Row[]>(
					"SELECT CLIENTE FROM campanhas_clientes WHERE CODIGO=?",
					[scheduleId],
				)
			)[0];
			if (!hint) return fail("SCHEDULE_UNAVAILABLE");
			customerId = Number(hint["CLIENTE"]);
			const customer = (
				await tx.execute<Row[]>(
					"SELECT ATIVO FROM clientes WHERE CODIGO=? FOR UPDATE",
					[customerId],
				)
			)[0];
			const schedule = (
				await tx.execute<Row[]>(
					"SELECT CLIENTE,OPERADOR,CONCLUIDO FROM campanhas_clientes WHERE CODIGO=? FOR UPDATE",
					[scheduleId],
				)
			)[0];
			if (
				!schedule ||
				Number(schedule["CLIENTE"]) !== customerId ||
				Number(schedule["OPERADOR"]) !== actorId ||
				schedule["CONCLUIDO"] !== "NAO" ||
				customer?.["ATIVO"] !== "SIM"
			)
				return fail("SCHEDULE_UNAVAILABLE");
		}
		await tx.execute(
			"INSERT INTO telephony_calls (id,operator_id,direction,number,extension,schedule_id,customer_id,state,prepared_at,updated_at) VALUES (?,?,?,?,?,?,?,'prepared',UTC_TIMESTAMP(),UTC_TIMESTAMP())",
			[
				callId,
				actorId,
				direction,
				number,
				text(input["extension"], 32, true),
				scheduleId,
				customerId,
			],
		);
		if (direction === "outgoing")
			await tx.execute(
				"UPDATE telephony_operator_state SET active_call_id=?,version=version+1,updated_at=UTC_TIMESTAMP() WHERE operator_id=?",
				[callId, actorId],
			);
		return { callId, state: "prepared" };
	}
	if (action === "event") {
		const callId = uuid(input["callId"]),
			eventId = uuid(input["eventId"]),
			type = text(input["type"], 20);
		if (
			![
				"sent",
				"ringing",
				"answered",
				"ended",
				"failed",
				"rejected",
				"transferred",
			].includes(type)
		)
			return fail("INVALID_REQUEST");
		const detail = text(input["detail"], 1000, true),
			sipCallId = text(input["sipCallId"], 255, true);
		const now = await clock(tx),
			at = observed(input["occurredAt"], now);
		const state = await lockState(tx, actorId);
		const saved = await receipt(tx, actorId, eventId, "event", input);
		if (saved) return saved;
		const rows = await tx.execute<Row[]>(
			"SELECT * FROM telephony_calls WHERE id=? AND operator_id=? FOR UPDATE",
			[callId, actorId],
		);
		if (!rows.length) return fail("CALL_UNAVAILABLE");
		const call = rows[0]!,
			terminal = ["ended", "failed", "rejected", "transferred"].includes(
				type,
			);
		await tx.execute(
			"INSERT INTO telephony_call_events (id,call_id,type,occurred_at,received_at,detail,sip_call_id) VALUES (?,?,?,?,UTC_TIMESTAMP(),?,?)",
			[eventId, callId, type, at, detail || null, sipCallId || null],
		);
		const column: Record<string, string> = {
			sent: "sent_at",
			ringing: "ringing_at",
			answered: "answered_at",
			ended: "ended_at",
			failed: "ended_at",
			rejected: "ended_at",
			transferred: "ended_at",
		};
		const nextState =
			call["ended_at"] && type !== "transferred" ? call["state"] : type;
		await tx.execute(
			`UPDATE telephony_calls SET ${column[type]}=IF(${column[type]} IS NULL OR ${column[type]}>?, ?,${column[type]}),state=IF(ended_at IS NOT NULL AND ?=0,state,?),updated_at=UTC_TIMESTAMP() WHERE id=?`,
			[at, at, terminal ? 1 : 0, nextState, callId],
		);
		if (call["schedule_id"] && type === "sent")
			await tx.execute(
				"UPDATE campanhas_clientes SET OPERADOR_LIGACAO=?,TELEFONE_LIGADO=?,DATA_HORA_LIG=DATE_ADD(?,INTERVAL TIMESTAMPDIFF(SECOND,@inpulse_crm_utc_at,@inpulse_crm_transfer_at) SECOND),DATA_HORA_FIM=NULL WHERE CODIGO=? AND OPERADOR=? AND CONCLUIDO='NAO'",
				[actorId, call["number"], at, call["schedule_id"], actorId],
			);
		if (call["schedule_id"] && terminal && call["sent_at"])
			await tx.execute(
				"UPDATE campanhas_clientes SET DATA_HORA_FIM=DATE_ADD(?,INTERVAL TIMESTAMPDIFF(SECOND,@inpulse_crm_utc_at,@inpulse_crm_transfer_at) SECOND) WHERE CODIGO=? AND OPERADOR=? AND CONCLUIDO='NAO'",
				[at, call["schedule_id"], actorId],
			);
		if (type === "answered" && !call["ended_at"])
			await tx.execute(
				"UPDATE telephony_operator_state SET active_call_id=?,version=version+1,updated_at=UTC_TIMESTAMP() WHERE operator_id=?",
				[callId, actorId],
			);
		if (terminal && state["active_call_id"] === callId)
			await tx.execute(
				"UPDATE telephony_operator_state SET active_call_id=NULL,version=version+1,updated_at=UTC_TIMESTAMP() WHERE operator_id=?",
				[actorId],
			);
		await saveReceipt(tx, actorId, eventId, "event", input, {
			applied: true,
		});
		return { applied: true };
	}
	if (action === "list" || action === "get") {
		const requested = integer(input["operatorId"], true) || actorId;
		if (requested !== actorId && user["NIVEL"] !== "ADMIN")
			return fail("FORBIDDEN");
		const params: unknown[] = [requested];
		let where = "c.operator_id=?";
		if (action === "get") {
			where += " AND c.id=?";
			params.push(uuid(input["callId"]));
		}
		const before =
			input["before"] == null ? null : text(input["before"], 36);
		if (before && action === "list") {
			where += " AND c.sequence_id<?";
			params.push(databaseId(before));
		}
		const limit =
			input["limit"] === undefined ? 50 : integer(input["limit"])!;
		if (limit > 100) return fail("INVALID_REQUEST");
		// MySQL 8 rejects mysql2's DOUBLE encoding for a prepared LIMIT. This is a bounded validated integer.
		const rows = await tx.execute<Row[]>(
			`SELECT c.*,r.rating,r.comment,r.version AS review_version FROM telephony_calls c LEFT JOIN telephony_call_reviews r ON r.call_id=c.id WHERE ${where} ORDER BY c.sequence_id DESC LIMIT ${limit}`,
			params,
		);
		return {
			calls: rows.map((row) => ({
				...callView(row),
				cursor: String(row["sequence_id"]),
			})),
		};
	}
	if (action === "review") {
		const operationId = uuid(input["operationId"]),
			callId = uuid(input["callId"]),
			comment = text(input["comment"], 1000, true),
			rating = input["rating"] ?? null;
		if (
			rating !== null &&
			!["RUIM", "MÉDIA", "BOA"].includes(String(rating))
		)
			return fail("INVALID_REQUEST");
		if (
			!Number.isSafeInteger(input["expectedVersion"]) ||
			Number(input["expectedVersion"]) < 0
		)
			return fail("INVALID_REQUEST");
		await lockState(tx, actorId);
		const saved = await receipt(tx, actorId, operationId, "review", input);
		if (saved) return saved;
		const calls = await tx.execute<Row[]>(
			"SELECT id,ended_at,sent_at,direction,state FROM telephony_calls WHERE id=? AND operator_id=? FOR UPDATE",
			[callId, actorId],
		);
		if (
			!calls.length ||
			(!calls[0]!["sent_at"] && calls[0]!["direction"] !== "incoming") ||
			(!calls[0]!["ended_at"] &&
				calls[0]!["state"] !== "observation_lost")
		)
			return fail("CALL_UNAVAILABLE");
		const reviews = await tx.execute<Row[]>(
			"SELECT version FROM telephony_call_reviews WHERE call_id=? FOR UPDATE",
			[callId],
		);
		if (Number(reviews[0]?.["version"] || 0) !== input["expectedVersion"])
			return fail("VERSION_CONFLICT");
		const version = Number(input["expectedVersion"]) + 1;
		await tx.execute(
			"INSERT INTO telephony_call_reviews (call_id,operator_id,rating,comment,version,created_at,updated_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE rating=VALUES(rating),comment=VALUES(comment),version=VALUES(version),updated_at=UTC_TIMESTAMP()",
			[callId, actorId, rating, comment, version],
		);
		await saveReceipt(tx, actorId, operationId, "review", input, {
			version,
		});
		return { version };
	}
	if (action === "pause") {
		const operationId = uuid(input["operationId"]),
			kind = text(input["kind"], 32);
		if (
			![
				"now",
				"after_attendance",
				"cancel_pending",
				"resume",
				"change_reason",
				"release_lost",
			"retry_pbx",
			].includes(kind)
		)
			return fail("INVALID_REQUEST");
		const state = await lockState(tx, actorId);
		const semantic = semanticPauseInput(input);
		const saved = await receipt(tx, actorId, operationId, "pause", semantic);
		if (saved) return saved;
		if ((kind === "now" || kind === "after_attendance") && Number(policy["pause_all_channels"]) === 1 &&
			(!Object.hasOwn(state, "unavailable_since") || input["scopeVerified"] !== "tenant-sql-v1" || input["scopePolicyRevision"] !== policy["preflight_hash"]))
			return fail("GLOBAL_SCOPE_UNAVAILABLE");
		if (Number(input["expectedVersion"]) !== Number(state["version"]))
			return fail("VERSION_CONFLICT");
		const now = await clock(tx),
			reasonId = integer(input["reasonId"], true);
		if (kind === "now" || kind === "after_attendance") {
			if (!reasonId || state["state"] !== "available")
				return fail("INVALID_STATE");
			const reasons = await tx.execute<Row[]>(
				"SELECT CODIGO FROM motivos_pausa WHERE CODIGO=?",
				[reasonId],
			);
			if (!reasons.length) return fail("REASON_UNAVAILABLE");
			if (kind === "now") {
				if (state["active_call_id"]) return fail("CALL_ACTIVE");
				await beginPause(tx, state, reasonId, now, operationId);
			} else {
				const calls = await tx.execute<Row[]>(
					"SELECT c.schedule_id FROM telephony_calls c INNER JOIN campanhas_clientes cc ON cc.CODIGO=c.schedule_id WHERE c.operator_id=? AND cc.OPERADOR=? AND cc.CONCLUIDO='NAO' ORDER BY c.sequence_id DESC LIMIT 1",
					[actorId, actorId],
				);
				if (!calls[0]?.["schedule_id"])
					return fail("SCHEDULE_UNAVAILABLE");
				await tx.execute(
					`UPDATE telephony_operator_state SET state='pending',reason_id=?,pending_schedule_id=?${Object.hasOwn(state, "unavailable_since") ? ",unavailable_since=?" : ""},version=version+1,updated_at=UTC_TIMESTAMP() WHERE operator_id=?`,
					[reasonId, calls[0]["schedule_id"], ...(Object.hasOwn(state, "unavailable_since") ? [await unavailableClock(tx)] : []), actorId],
				);
			}
		} else if (kind === "cancel_pending") {
			if (state["state"] !== "pending") return fail("INVALID_STATE");
			await tx.execute(
				`UPDATE telephony_operator_state SET state='available',reason_id=NULL,pending_schedule_id=NULL${Object.hasOwn(state, "unavailable_since") ? ",unavailable_since=NULL" : ""},version=version+1,updated_at=UTC_TIMESTAMP() WHERE operator_id=?`,
				[actorId],
			);
		} else if (kind === "resume") {
			if (state["state"] !== "paused") return fail("INVALID_STATE");
			// Offline incoming resume retains its observed end, never a fabricated call end.
			const observedAt = input["occurredAt"]
				? observed(input["occurredAt"], now)
				: now;
			const at =
				Date.parse(iso(observedAt)!) > Date.parse(iso(now)!)
					? now
					: observedAt;
			await closePause(tx, state, at);
			await tx.execute(
				`UPDATE telephony_operator_state SET state='available',reason_id=NULL,pause_id=NULL${Object.hasOwn(state, "unavailable_since") ? ",unavailable_since=NULL" : ""},version=version+1,updated_at=UTC_TIMESTAMP() WHERE operator_id=?`,
				[actorId],
			);
			await enqueuePbx(tx, actorId, false, operationId);
		} else if (kind === "retry_pbx") {
			await enqueuePbx(tx,actorId,state["state"]==="paused",operationId);
		} else if (kind === "release_lost") {
			if (!state["active_call_id"] || input["confirmNoCall"] !== true)
				return fail("INVALID_STATE");
			await tx.execute(
				"UPDATE telephony_calls SET state='observation_lost',updated_at=UTC_TIMESTAMP() WHERE id=? AND operator_id=? AND ended_at IS NULL",
				[state["active_call_id"], actorId],
			);
			await tx.execute(
				"UPDATE telephony_operator_state SET active_call_id=NULL,version=version+1,updated_at=UTC_TIMESTAMP() WHERE operator_id=?",
				[actorId],
			);
		} else {
			if (
				state["state"] !== "paused" ||
				!reasonId ||
				!(await canChangeReason(tx, policy["allow_change_reason"]))
			)
				return fail("INVALID_STATE");
			await closePause(tx, state, now);
			await beginPause(tx, state, reasonId, now, operationId);
		}
		const result = await stateView(tx, actorId);
		await saveReceipt(tx, actorId, operationId, "pause", semantic, result);
		return result;
	}
	if (action === "pbx.pending")
		return {
			intents: await tx.execute<Row[]>(
				"SELECT p.id,p.operation_id,p.queue_name,p.member_interface,p.paused,p.status FROM telephony_pbx_intents p WHERE p.operator_id=? AND p.status IN ('pending','unknown') AND NOT EXISTS (SELECT 1 FROM telephony_pbx_intents newer WHERE newer.operator_id=p.operator_id AND newer.queue_name=p.queue_name AND newer.member_interface=p.member_interface AND newer.id>p.id) ORDER BY p.id LIMIT 20",
				[actorId],
			),
		};
	if (action === "pbx.result") {
		const id = databaseId(input["id"]),
			status = text(input["status"], 20);
		if (!["confirmed", "failed", "unknown"].includes(status))
			return fail("INVALID_REQUEST");
		await tx.execute(
			"UPDATE telephony_pbx_intents SET status=?,detail=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND operator_id=? AND status IN ('pending','unknown')",
			[status, text(input["detail"], 200, true) || null, id, actorId],
		);
		return { applied: true };
	}
	if (action === "metrics") return runtimeMetrics(tx, actorId);
	return fail("INVALID_REQUEST");
}

export async function afterTelephonyFinish(
	tx: TenantTransaction,
	context: {
		actorId: number;
		scheduleId: number;
		callId?: string;
		successorScheduleId?: number | null;
		finishedAt: unknown;
		historyId?: number;
	},
) {
	const state = await lockState(tx, context.actorId);
	if (context.callId) {
		const calls = await tx.execute<Row[]>(
			"SELECT id FROM telephony_calls WHERE id=? AND operator_id=? AND schedule_id=? FOR UPDATE",
			[context.callId, context.actorId, context.scheduleId],
		);
		if (!calls.length) return fail("CALL_UNAVAILABLE");
		if (context.historyId)
			await tx.execute(
				"UPDATE telephony_calls SET history_id=? WHERE id=?",
				[context.historyId, context.callId],
			);
	}
	if (state["active_call_id"]) return fail("CALL_ACTIVE");
	if (
		state["state"] === "pending" &&
		Number(state["pending_schedule_id"]) === context.scheduleId
	)
		await beginPause(
			tx,
			state,
			Number(state["reason_id"]),
			await clock(tx),
			`finish-${context.scheduleId}`,
		);
}

export async function runRuntime(
	database: Pick<TenantDatabase, "transaction">,
	tenant: string,
	command: RuntimeCommand,
) {
	// Detect disabled/unmigrated tenants through existing tables before touching new tables.
	const enabled = await database.transaction(
		tenant,
		"telephony.runtime.discovery",
		["operadores"],
		async (tx) => {
			await actor(tx, command.actorId);
			const present = await tx.execute<Row[]>(
				"SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='telephony_runtime_policy'",
				[],
			);
			if (!present.length) return false;
			const rows = await tx.execute<Row[]>(
				"SELECT enabled FROM telephony_runtime_policy WHERE id=1",
				[],
			);
			return Number(rows[0]?.["enabled"]) === 1;
		},
	);
	if (!enabled) {
		if (command.action === "status")
			return {
				enabled: false,
				state: "available",
				version: 0,
				reasons: [],
				serverNow: new Date().toISOString(),
			};
		return fail("DISABLED");
	}
	return database.transaction(
		tenant,
		"telephony.runtime",
		[...runtimeTables, "telephony_web_sessions"],
		async (tx) => {
			const mutated = [
				...runtimeTables.slice(0, 9),
				"telephony_web_sessions",
				...(command.action === "event" ? ["campanhas_clientes"] : []),
			];
			const triggers = await tx.execute<Row[]>(
				`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN (${mutated.map(() => "?").join(",")})`,
				mutated,
			);
			if (triggers.length) return fail("UNREVIEWED_TRIGGERS");
			return executeRuntime(tx, command);
		},
	);
}
