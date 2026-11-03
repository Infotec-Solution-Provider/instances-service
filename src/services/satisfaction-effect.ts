import { TenantDatabaseError } from "../tenant-database/error";
type Statement = {
	sql: string;
	params: (string | number | boolean | null)[];
	expectAffectedRows: number;
};
const invalid = (): never => {
	throw new TenantDatabaseError("TENANT_TRANSACTION_INVALID_REQUEST");
};
const receiptSql =
	"INSERT INTO telephony_schedule_finishes (operation_id,request_hash,schedule_id,actor_id,created_at) VALUES (?,?,?,?,UTC_TIMESTAMP())";
const snapshotSql =
	"INSERT INTO telephony_satisfaction_submissions (operation_id,schedule_id,actor_id,history_id,survey_json,created_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP())";
/** Checks the exact signed SQL and cross-wires receipt, serialized survey and persisted answers. */
export function validateSatisfactionEffects(
	statements: Statement[],
	questions: { id: number; description: string }[],
	scheduleId: number,
): void {
	const receipt = statements[2]!,
		snapshot = statements[3]!,
		answers = statements[4]!;
	if (
		receipt.sql !== receiptSql ||
		receipt.params.length !== 4 ||
		receipt.params[2] !== scheduleId ||
		typeof receipt.params[0] !== "string" ||
		typeof receipt.params[1] !== "string" ||
		!/^[a-f0-9]{64}$/.test(receipt.params[1]) ||
		!Number.isInteger(receipt.params[3]) ||
		Number(receipt.params[3]) < 1 ||
		snapshot.sql !== snapshotSql ||
		snapshot.params[0] !== receipt.params[0] ||
		snapshot.params[2] !== receipt.params[3] ||
		answers.sql !==
			`INSERT INTO pesquisa_satisfacao_avaliacao (CAMPCLI_CODIGO,PESQSAT_CODIGO,PESQSAT_AVALIACAO) VALUES ${questions.map(() => "(?,?,?)").join(",")}`
	)
		return invalid();
	let survey: unknown;
	try {
		survey = JSON.parse(String(snapshot.params[4]));
	} catch {
		return invalid();
	}
	if (!survey || typeof survey !== "object" || Array.isArray(survey))
		return invalid();
	const body = survey as Record<string, unknown>;
	if (
		Object.keys(body).some(
			(key) => !["questions", "answers"].includes(key),
		) ||
		!Array.isArray(body["questions"]) ||
		!Array.isArray(body["answers"]) ||
		body["questions"].length !== questions.length ||
		body["answers"].length !== questions.length
	)
		return invalid();
	if (
		body["questions"].some(
			(value, index) =>
				!value ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				Object.keys(value).some(
					(key) => !["id", "description"].includes(key),
				) ||
				value.id !== questions[index]!.id ||
				value.description !== questions[index]!.description,
		)
	)
		return invalid();
	const values = new Map<number, string>();
	for (const answer of body["answers"]) {
		if (
			!answer ||
			typeof answer !== "object" ||
			Array.isArray(answer) ||
			Object.keys(answer).some(
				(key) => !["questionId", "rating"].includes(key),
			) ||
			!questions.some((q) => q.id === answer.questionId) ||
			values.has(answer.questionId) ||
			(answer.rating !== null &&
				(!Number.isInteger(answer.rating) ||
					answer.rating < 1 ||
					answer.rating > 5))
		)
			return invalid();
		values.set(
			answer.questionId,
			answer.rating === null ? "" : String(answer.rating),
		);
	}
	if (
		questions.some(
			(question, index) =>
				answers.params[index * 3] !== scheduleId ||
				answers.params[index * 3 + 1] !== question.id ||
				answers.params[index * 3 + 2] !== values.get(question.id),
		)
	)
		return invalid();
}
