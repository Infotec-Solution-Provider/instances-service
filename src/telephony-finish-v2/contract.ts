export class FinishV2Error extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
	) {
		super(message);
	}
}
export const refuse = (
	message: string,
	status = 400,
	code = "TELEPHONY_FINISH_INVALID",
): never => {
	throw new FinishV2Error(status, code, message);
};
export interface FinishSurvey {
	questions: { id: number; description: string }[];
	answers: { questionId: number; rating: number | null }[];
}
export interface FinishCommand {
	operationId: string;
	resultId: number;
	observation: string;
	callId?: string;
	scheduleDate?: string;
	redialPhone?: string;
	delegateOperatorId?: number;
	phaseContactId?: number;
	priority?: boolean;
	confirmInactivation?: boolean;
	proposalValue?: string;
	cancelProposals?: { id: number; version: string }[];
	survey?: FinishSurvey;
	sale?: {
		description: string;
		value: string;
		paymentMethod: string;
		proposalIds: number[];
	};
}
export interface FinishV2Input {
	operation: "telephony.schedule.finish.v2";
	scheduleId: number;
	actorId: number;
	command: FinishCommand;
}
export interface FinishV2Receipt {
	operationId: string;
	scheduleId: number;
	successorScheduleId: number | null;
	historyId: number;
	saleId: number | null;
	finishedAt: string;
}
export function positive(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > 2147483647
	)
		return refuse("Código inválido.");
	return value;
}
export function uuid(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value,
		)
	)
		return refuse("Operação inválida.");
	return value.toLowerCase();
}
type InputRecord = Record<
	| "priority"
	| "confirmInactivation"
	| "actorId"
	| "answers"
	| "callId"
	| "cancelProposals"
	| "command"
	| "delegateOperatorId"
	| "phaseContactId"
	| "description"
	| "id"
	| "observation"
	| "operation"
	| "operationId"
	| "paymentMethod"
	| "proposalIds"
	| "proposalValue"
	| "questionId"
	| "questions"
	| "rating"
	| "redialPhone"
	| "resultId"
	| "sale"
	| "scheduleDate"
	| "scheduleId"
	| "survey"
	| "value"
	| "version",
	unknown
>;
function record(value: unknown, keys: string[]): InputRecord {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((k) => !keys.includes(k))
	)
		return refuse("Campo de finalização não permitido.");
	return value as InputRecord;
}
function text(value: unknown, max: number, required = false): string {
	if (
		typeof value !== "string" ||
		value.trim().length > max ||
		/[^\u0020-\u007e\u00a0-\u00ff\r\n\t]/.test(value) ||
		(required && !value.trim())
	)
		return refuse("Texto inválido na finalização.");
	return value.trim();
}
export function money(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value) ||
		Number(value) <= 0
	)
		return refuse("Informe um valor positivo com até duas casas decimais.");
	const [whole, frac = ""] = value.split(".");
	return `${whole}.${frac.padEnd(2, "0")}`;
}
export function civil(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(
			value,
		)
	)
		return refuse("Informe data e hora válidas no horário do CRM.");
	const normalized = (value.length === 16 ? value + ":00" : value).replace(
			" ",
			"T",
		),
		date = new Date(normalized + "Z");
	if (
		!Number.isFinite(date.getTime()) ||
		date.toISOString().slice(0, 19) !== normalized ||
		normalized < "1000"
	)
		return refuse("Data inválida.");
	return normalized.replace("T", " ");
}
export function parseFinishCommand(value: unknown): FinishCommand {
	const b = record(value, [
		"operationId",
		"resultId",
		"observation",
		"callId",
		"scheduleDate",
		"redialPhone",
		"delegateOperatorId",
		"phaseContactId",
		"priority",
		"confirmInactivation",
		"proposalValue",
		"cancelProposals",
		"survey",
		"sale",
	]);
	const result: FinishCommand = {
		operationId: uuid(b["operationId"]),
		resultId: positive(b["resultId"]),
		observation: text(b["observation"], 4000),
	};
	if (b["callId"] !== undefined) result.callId = uuid(b["callId"]);
	if (b["scheduleDate"] !== undefined)
		result.scheduleDate = civil(b["scheduleDate"]);
	if (b["redialPhone"] !== undefined) {
		if (
			typeof b["redialPhone"] !== "string" ||
			!/^\d{10,12}$/.test(b["redialPhone"])
		)
			return refuse("Selecione um telefone válido para rediscar.");
		result.redialPhone = b["redialPhone"];
	}
	if (b["delegateOperatorId"] !== undefined)
		result.delegateOperatorId = positive(b["delegateOperatorId"]);
	if (b["phaseContactId"] !== undefined)
		result.phaseContactId = positive(b["phaseContactId"]);
	for (const key of ["priority", "confirmInactivation"] as const)
		if (b[key] !== undefined) {
			if (typeof b[key] !== "boolean")
				return refuse("Confirmação inválida.");
			result[key] = b[key];
		}
	if (b["proposalValue"] !== undefined)
		result.proposalValue = money(b["proposalValue"]);
	if (b["cancelProposals"] !== undefined) {
		if (
			!Array.isArray(b["cancelProposals"]) ||
			b["cancelProposals"].length > 20
		)
			return refuse("Seleção de propostas inválida.");
		result.cancelProposals = b.cancelProposals
			.map((raw) => {
				const p = record(raw, ["id", "version"]);
				if (
					typeof p.version !== "string" ||
					!/^[a-f0-9]{64}$/.test(p.version)
				)
					return refuse("Releia as propostas.");
				return { id: positive(p.id), version: p.version };
			})
			.sort((a, b) => a.id - b.id);
		if (
			new Set(result.cancelProposals.map((p) => p.id)).size !==
			result.cancelProposals.length
		)
			return refuse("Proposta duplicada.");
	}
	if (b["survey"] !== undefined) {
		const s = record(b["survey"], ["questions", "answers"]);
		if (
			!Array.isArray(s["questions"]) ||
			!s["questions"].length ||
			s["questions"].length > 100 ||
			!Array.isArray(s["answers"]) ||
			s["answers"].length !== s["questions"].length
		)
			return refuse("Pesquisa inválida.");
		const questions = s["questions"]
			.map((q) => {
				const p = record(q, ["id", "description"]);
				return {
					id: positive(p["id"]),
					description: text(p["description"], 1000, true),
				};
			})
			.sort((a, b) => a.id - b.id);
		const answers = s["answers"]
			.map((a) => {
				const p = record(a, ["questionId", "rating"]);
				if (
					p["rating"] !== null &&
					(typeof p["rating"] !== "number" ||
						!Number.isInteger(p["rating"]) ||
						p["rating"] < 1 ||
						p["rating"] > 5)
				)
					return refuse("Responda a pesquisa.");
				return {
					questionId: positive(p["questionId"]),
					rating: p["rating"] as number | null,
				};
			})
			.sort((a, b) => a.questionId - b.questionId);
		if (
			new Set(questions.map((q) => q.id)).size !== questions.length ||
			answers.some((a, i) => a.questionId !== questions[i]!.id)
		)
			return refuse("Responda todas as perguntas.");
		result.survey = { questions, answers };
	}
	if (b["sale"] !== undefined) {
		const s = record(b["sale"], [
			"description",
			"value",
			"paymentMethod",
			"proposalIds",
		]);
		if (!Array.isArray(s["proposalIds"]) || s["proposalIds"].length > 20)
			return refuse("Propostas da venda inválidas.");
		const ids = s["proposalIds"].map(positive).sort((a, b) => a - b);
		if (new Set(ids).size !== ids.length)
			return refuse("Proposta duplicada.");
		result.sale = {
			description: text(s["description"], 60, true),
			value: money(s["value"]),
			paymentMethod: text(s["paymentMethod"], 255, true),
			proposalIds: ids,
		};
	}
	return result;
}
export function parseFinishV2(value: unknown): FinishV2Input {
	const b = record(value, ["operation", "scheduleId", "actorId", "command"]);
	if (b["operation"] !== "telephony.schedule.finish.v2")
		return refuse("Operação inválida.");
	return {
		operation: b.operation,
		scheduleId: positive(b.scheduleId),
		actorId: positive(b.actorId),
		command: parseFinishCommand(b.command),
	};
}
/** Calendar offsets match Delphi IncMonth/IncYear, including month-end clamping. */
export function successorDate(
	action: number,
	explicit: string | undefined,
	crmNow: string,
): string | null {
	if ([2, 7, 8].includes(action)) {
		if (!explicit) return refuse("Informe a data de reagendamento.");
		return explicit;
	}
	if (explicit) return refuse("Este resultado não aceita data manual.");
	const d = new Date(crmNow.replace(" ", "T") + "Z");
	if (!Number.isFinite(d.getTime()))
		return refuse("Horário CRM indisponível.", 503);
	const days: Record<number, number> = {
			9: 15,
			11: 1,
			12: 7,
			14: 1,
			19: 2,
			20: 4,
		},
		months: Record<number, number> = { 4: 1, 5: 6, 13: 3, 15: 2, 16: 12 };
	if (action === 1) {
	} else if (action === 3) d.setUTCMinutes(d.getUTCMinutes() + 20);
	else if (action === 18) d.setUTCHours(d.getUTCHours() + 1);
	else if (days[action]) d.setUTCDate(d.getUTCDate() + days[action]!);
	else if (months[action]) {
		const day = d.getUTCDate();
		d.setUTCDate(1);
		d.setUTCMonth(d.getUTCMonth() + months[action]!);
		const last = new Date(
			Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
		).getUTCDate();
		d.setUTCDate(Math.min(day, last));
	} else if ([6, 10].includes(action)) return null;
	else
		return refuse(
			"A ação deste resultado ainda não é suportada.",
			409,
			"TELEPHONY_FINISH_UNSUPPORTED_ACTION",
		);
	return d.toISOString().slice(0, 19).replace("T", " ");
}
export function nextLoyalty(input: {
	quantity: number;
	previousId: number;
	configured: number;
	contact: boolean;
	resultLoyalty: boolean;
	scheduleLoyalty: boolean;
	zero: boolean;
}): { quantity: number; origin: number } | null {
	const i = input;
	if (!i.resultLoyalty && (!i.scheduleLoyalty || !i.contact)) return null;
	let quantity = i.quantity,
		origin = i.previousId;
	if (i.resultLoyalty && !i.zero && i.configured >= quantity - 1) {
		quantity = i.configured;
		origin = 0;
	} else if (i.zero && quantity === 0 && i.resultLoyalty) {
		quantity = i.configured;
		origin = 0;
	} else if (i.contact) quantity--;
	return (i.contact && origin > 0 && quantity >= 0) ||
		(i.resultLoyalty && quantity > 0)
		? { quantity, origin }
		: null;
}
