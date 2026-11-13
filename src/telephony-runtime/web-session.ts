import type { TenantTransaction } from "../tenant-database/transaction";
import { fail, uuid } from "./contract";

interface SessionRow {
	id: number;
	operator_id: number;
	segment: number;
	ended_at: unknown;
	gap_seconds: number;
}
/** A gap is not connected time. Only server-observed intervals contribute to the dashboard. */
export async function handleWebSession(
	tx: TenantTransaction,
	actorId: number,
	input: Record<string, unknown>,
) {
	const sessionId = uuid(input["sessionId"]),
		kind = input["kind"];
	if (!["connect", "heartbeat", "disconnect"].includes(String(kind)))
		return fail("INVALID_REQUEST");
	const rows = await tx.execute<SessionRow[]>(
		"SELECT id,operator_id,segment,ended_at,TIMESTAMPDIFF(SECOND,last_seen,UTC_TIMESTAMP()) AS gap_seconds FROM telephony_web_sessions WHERE session_id=? ORDER BY segment DESC LIMIT 1 FOR UPDATE",
		[sessionId],
	);
	const current = rows[0];
	if (current && Number(current.operator_id) !== actorId)
		return fail("FORBIDDEN");
	if (current?.ended_at) {
		if (kind !== "connect") return { observed: false };
		await tx.execute(
			"INSERT INTO telephony_web_sessions (session_id,segment,operator_id,started_at,last_seen) VALUES (?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())",
			[sessionId, Number(current.segment) + 1, actorId],
		);
		return { observed: true };
	}
	if (!current) {
		if (kind !== "connect") return { observed: false };
		await tx.execute(
			"INSERT INTO telephony_web_sessions (session_id,segment,operator_id,started_at,last_seen) VALUES (?,1,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())",
			[sessionId, actorId],
		);
	} else if (Number(current.gap_seconds) > 90) {
		await tx.execute(
			"UPDATE telephony_web_sessions SET ended_at=last_seen,end_reason='gap' WHERE id=? AND ended_at IS NULL",
			[current.id],
		);
		if (kind !== "disconnect")
			await tx.execute(
				"INSERT INTO telephony_web_sessions (session_id,segment,operator_id,started_at,last_seen) VALUES (?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())",
				[sessionId, Number(current.segment) + 1, actorId],
			);
	} else if (kind === "disconnect") {
		await tx.execute(
			"UPDATE telephony_web_sessions SET last_seen=UTC_TIMESTAMP(),ended_at=UTC_TIMESTAMP(),end_reason='disconnect' WHERE id=? AND ended_at IS NULL",
			[current.id],
		);
	} else
		await tx.execute(
			"UPDATE telephony_web_sessions SET last_seen=UTC_TIMESTAMP() WHERE id=? AND ended_at IS NULL",
			[current.id],
		);
	return { observed: true };
}
