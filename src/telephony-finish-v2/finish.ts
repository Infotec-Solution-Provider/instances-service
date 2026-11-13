import { createHash } from "node:crypto";
import type { TenantTransaction } from "../tenant-database/transaction";
import { lockTelephonyOperator } from "../telephony-runtime/runtime";
import {
	nextLoyalty,
	successorDate,
	refuse,
	type FinishV2Input,
	type FinishV2Receipt,
} from "./contract";

type Row = Record<string, string | number | null>;
export const finishV2Tables = [
	"telephony_finish_policy",
	"telephony_finish_operations",
	"campanhas_clientes",
	"clientes",
	"campanhas",
	"operadores",
	"resultados",
	"parametros",
	"historico_cli",
	"fidelizacoes",
	"transferencia_clientes",
	"transferencia_clientes_itens",
	"propostas",
	"propostas_compras",
	"crm_proposal_events",
	"compras",
	"pesquisa_satisfacao",
	"pesquisa_satisfacao_avaliacao",
	"telephony_satisfaction_submissions",
	"motivo_desativacao_cliente",
	"cliente_bloqueado",
	"campanhas_clientes_log",
	"telephony_operator_state",
	"telephony_pause_segments",
	"telephony_runtime_operations",
	"telephony_runtime_policy",
	"telephony_calls",
	"telephony_pbx_members",
	"telephony_pbx_intents",
	"motivos_pausa",
	"fase_contato",
	"unidades",
];
const written = [
	"telephony_finish_operations",
	"campanhas_clientes",
	"clientes",
	"historico_cli",
	"fidelizacoes",
	"propostas",
	"propostas_compras",
	"crm_proposal_events",
	"compras",
	"pesquisa_satisfacao_avaliacao",
	"telephony_satisfaction_submissions",
	"motivo_desativacao_cliente",
	"cliente_bloqueado",
	"campanhas_clientes_log",
	"telephony_operator_state",
	"telephony_pause_segments",
	"telephony_runtime_operations",
	"telephony_calls",
	"telephony_pbx_intents",
];
const enabled = (value: unknown) =>
	value === "SIM" ||
	value === "S" ||
	value === 1 ||
	value === true ||
	value === "1";
const conflict = (
	message = "O atendimento mudou. Releia a fila antes de finalizar.",
): never => refuse(message, 409, "TELEPHONY_FINISH_CHANGED");
const policyFailure = (): never =>
	refuse(
		"A finalização avançada precisa de conferência e ativação para esta empresa.",
		409,
		"TELEPHONY_FINISH_POLICY_UNAVAILABLE",
	);
function ack(value: unknown): number {
	if (
		!value ||
		typeof value !== "object" ||
		!("affectedRows" in value) ||
		value.affectedRows !== 1
	)
		return conflict();
	return Number("insertId" in value ? value.insertId : 0) || 0;
}
function sqlDate(value: unknown): string | null {
	if (value instanceof Date)
		return value.toISOString().slice(0, 19).replace("T", " ");
	if (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}/.test(value) &&
		value > "1000"
	)
		return value.replace("T", " ").slice(0, 19);
	return null;
}
export type FinishHook = (
	tx: TenantTransaction,
	event: {
		actorId: number;
		scheduleId: number;
		callId?: string;
		successorScheduleId: number | null;
		finishedAt: string;
		historyId: number;
	},
) => Promise<void>;
export interface FinishHooks {
	afterFinish?: FinishHook;
}
export function finishHash(input: FinishV2Input): string {
	return createHash("sha256")
		.update(
			JSON.stringify([input.scheduleId, input.actorId, input.command]),
		)
		.digest("hex");
}
/** One durable command owns every CRM effect. No arbitrary caller SQL or external calls. */
export async function finishTelephonyV2(
	tx: TenantTransaction,
	input: FinishV2Input,
	hooks: FinishHooks = {},
): Promise<FinishV2Receipt> {
	const { command: c, actorId, scheduleId } = input,
		hash = finishHash(input);
	// Operator/runtime lock order matches runtime commands, before the customer and schedules.
	const actor = (
		await tx.execute<Row[]>(
			"SELECT CODIGO,LOGIN,NOME,ATIVO,NIVEL FROM operadores WHERE CODIGO=? FOR UPDATE",
			[actorId],
		)
	)[0];
	if (!actor || actor["ATIVO"] !== "SIM")
		return refuse(
			"Operador indisponível.",
			403,
			"TELEPHONY_FINISH_FORBIDDEN",
		);
	const receipts = await tx.execute<Row[]>(
		"SELECT actor_id,schedule_id,request_hash,result_json FROM telephony_finish_operations WHERE operation_id=? FOR UPDATE",
		[c.operationId],
	);
	if (receipts[0]) {
		const r = receipts[0];
		if (
			Number(r["actor_id"]) !== actorId ||
			Number(r["schedule_id"]) !== scheduleId ||
			r["request_hash"] !== hash
		)
			return conflict("Esta operação já foi usada para outro comando.");
		return JSON.parse(String(r["result_json"])) as FinishV2Receipt;
	}
	const policy = (
		await tx.execute<Row[]>(
			"SELECT * FROM telephony_finish_policy WHERE id=1 FOR UPDATE",
		)
	)[0];
	if (
		!policy ||
		!enabled(policy["enabled"]) ||
		!enabled(policy["exclusive_writer"]) ||
		!/^[a-f0-9]{64}$/.test(String(policy["preflight_revision"]))
	)
		return policyFailure();
	const triggers = await tx.execute<Row[]>(
		`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN (${written.map(() => "?").join(",")}) LIMIT 1`,
		written,
	);
	if (triggers.length)
		return refuse(
			"Há efeitos de banco ainda não revisados.",
			409,
			"TELEPHONY_FINISH_SCHEMA_UNREVIEWED",
		);
	await lockTelephonyOperator(tx, actorId);
	const initial = (
		await tx.execute<Row[]>(
			"SELECT CLIENTE FROM campanhas_clientes WHERE CODIGO=?",
			[scheduleId],
		)
	)[0];
	if (!initial) return conflict();
	const customer = (
		await tx.execute<Row[]>(
			"SELECT * FROM clientes WHERE CODIGO=? FOR UPDATE",
			[initial["CLIENTE"]],
		)
	)[0];
	if (!customer) return conflict();
	const schedules = await tx.execute<Row[]>(
		"SELECT *,CAST(DT_AGENDAMENTO AS CHAR) AS scheduled_text,CAST(DATA_HORA_LIG AS CHAR) AS started_text FROM campanhas_clientes WHERE CLIENTE=? ORDER BY CODIGO LIMIT 2001 FOR UPDATE",
		[customer["CODIGO"]],
	);
	if (schedules.length > 2000)
		return refuse(
			"O cliente exige revisão de agendas antes de finalizar.",
			409,
			"TELEPHONY_FINISH_TOO_MANY_SCHEDULES",
		);
	const current = schedules.find((s) => Number(s["CODIGO"]) === scheduleId);
	if (
		!current ||
		Number(current["OPERADOR"]) !== actorId ||
		(current["CONCLUIDO"] !== "NAO" && current["CONCLUIDO"] !== null)
	)
		return conflict();
	const result = (
		await tx.execute<Row[]>(
			"SELECT * FROM resultados WHERE CODIGO=? FOR UPDATE",
			[c.resultId],
		)
	)[0];
	if (!result || !Number.isInteger(Number(result["COD_ACAO"])))
		return conflict();
	if (result["TIPO"] && !["ATIVO", "AMBOS"].includes(String(result["TIPO"])))
		return refuse("Resultado não disponível para telefonia ativa.");
	const p = await tx.execute<Row[]>(
		"SELECT * FROM parametros ORDER BY CODIGO LIMIT 2 FOR UPDATE",
	);
	if (p.length !== 1) return policyFailure();
	const params = p[0]!;
	const now = (
		await tx.execute<Row[]>(
			"SELECT DATE_FORMAT(@inpulse_crm_transfer_at,'%Y-%m-%d %H:%i:%s') AS crmNow",
		)
	)[0]?.["crmNow"];
	if (typeof now !== "string") return policyFailure();
	const action = Number(result["COD_ACAO"]),
		next = successorDate(action, c.scheduleDate, now);
	if (!c.observation && !enabled(params["PERMITE_FINALIZAR_SEM_OBS"]))
		return refuse("Informe a observação do atendimento.");
	const phaseRequired =
		enabled(params["EXIGIR_FASE_CONTATO"]) &&
		enabled(params["EXIBIR_FASE_CONTATO"]);
	if (phaseRequired && !c.phaseContactId)
		return refuse("Informe a fase do contato.");
	if (c.phaseContactId) {
		if (!enabled(params["EXIBIR_FASE_CONTATO"]))
			return refuse("Fase de contato indisponível.");
		const phases = await tx.execute<{ EXIGE_OBSERVACAO: string }[]>(
			"SELECT EXIGE_OBSERVACAO FROM fase_contato WHERE CODIGO=? FOR UPDATE",
			[c.phaseContactId],
		);
		if (!phases.length) return conflict("A fase de contato mudou.");
		if (enabled(phases[0]!.EXIGE_OBSERVACAO) && !c.observation)
			return refuse("Esta fase exige observação.");
	}
	if ((action === 1) !== Boolean(c.redialPhone))
		return refuse(
			action === 1
				? "Selecione o telefone para rediscar."
				: "Este resultado não aceita telefone de rediscagem.",
		);
	if ((action === 8) !== Boolean(c.delegateOperatorId))
		return refuse(
			action === 8
				? "Selecione o operador destinatário."
				: "Este resultado não delega atendimento.",
		);
	if (action === 6 && !c.confirmInactivation)
		return refuse("Confirme a inativação do cliente.");
	if (c.confirmInactivation && action !== 6)
		return refuse("Este resultado não inativa o cliente.");
	if (c.priority && enabled(params["OCULTAR_ALTAPRIORIDADE"]))
		return refuse("Alta prioridade não está disponível.");
	if (enabled(result["PROPOSTA"]) !== Boolean(c.proposalValue))
		return refuse("Revise o valor de proposta exigido pelo resultado.");
	if (
		enabled(result["CANCELAPROPOSTA"]) !==
		Boolean(c.cancelProposals?.length)
	)
		return refuse("Revise a seleção de propostas a cancelar.");
	const needsSale =
		enabled(policy["sale_enabled"]) && enabled(result["EVENDA"]);
	if (needsSale !== Boolean(c.sale))
		return refuse(
			needsSale
				? "Informe os dados da venda antes de finalizar."
				: "Este resultado não aceita venda acoplada.",
		);
	if (c.delegateOperatorId) {
		const target = (
			await tx.execute<Row[]>(
				"SELECT CODIGO,ATIVO,NIVEL FROM operadores WHERE CODIGO=? FOR UPDATE",
				[c.delegateOperatorId],
			)
		)[0];
		if (
			!target ||
			target["ATIVO"] !== "SIM" ||
			c.delegateOperatorId === actorId ||
			(target["NIVEL"] === "ADMIN" &&
				!enabled(params["AGENDAMENTO_SUPERVISOR"]))
		)
			return refuse(
				"Selecione outro operador ativo autorizado a receber agendas.",
			);
	}
	if (c.survey) {
		if (!enabled(result["PESQUISA_SATISFACAO"]))
			return refuse("Este resultado não aceita pesquisa.");
		const questions = await tx.execute<Row[]>(
			"SELECT PESQSAT_CODIGO,PESQ_DESCRICAO FROM pesquisa_satisfacao ORDER BY PESQSAT_CODIGO LIMIT 101 FOR UPDATE",
		);
		if (
			JSON.stringify(
				questions.map((q) => ({
					id: Number(q["PESQSAT_CODIGO"]),
					description: q["PESQ_DESCRICAO"],
				})),
			) !== JSON.stringify(c.survey.questions)
		)
			return conflict("A pesquisa mudou. Reabra a finalização.");
		const existing = await tx.execute<Row[]>(
			"SELECT PESQSAT_CODIGO FROM pesquisa_satisfacao_avaliacao WHERE CAMPCLI_CODIGO=? LIMIT 1 FOR UPDATE",
			[scheduleId],
		);
		if (existing.length)
			return conflict("Esta chamada já possui pesquisa.");
	} else if (enabled(result["PESQUISA_SATISFACAO"]))
		return refuse("Responda a pesquisa obrigatória.");
	const campaign = (
		await tx.execute<Row[]>(
			"SELECT CODIGO,NOME,UNIDADE,TIPO FROM campanhas WHERE CODIGO=? FOR UPDATE",
			[current["CAMPANHA"]],
		)
	)[0];
	if (!campaign) return conflict();
	const phone = String(
		current["TELEFONE_LIGADO"] ||
			current["FONE1"] ||
			current["FONE2"] ||
			current["FONE3"] ||
			"",
	).trim();
	if (!phone || phone.length > 15)
		return refuse("O telefone da chamada deve caber no histórico CRM.");
	let started = sqlDate(current["started_text"]) || now;
	if (c.callId) {
		const call = (
			await tx.execute<Row[]>(
				"SELECT *,CAST(TIMESTAMPADD(SECOND,TIMESTAMPDIFF(SECOND,@inpulse_crm_utc_at,@inpulse_crm_transfer_at),COALESCE(sent_at,prepared_at)) AS CHAR) AS crmStarted FROM telephony_calls WHERE id=? FOR UPDATE",
				[c.callId],
			)
		)[0];
		if (
			!call ||
			Number(call["operator_id"]) !== actorId ||
			Number(call["schedule_id"]) !== scheduleId
		)
			return conflict("A chamada não corresponde a este atendimento.");
		if (
			![
				"ended",
				"failed",
				"rejected",
				"cancelled",
				"transferred",
			].includes(String(call["state"]))
		)
			return conflict("Desligue a chamada antes de finalizar.");
		started = sqlDate(call["crmStarted"]) || started;
	}
	if (started > now)
		return conflict(
			"O início da chamada está posterior ao horário do CRM.",
		);
	ack(
		await tx.execute(
			"UPDATE campanhas_clientes SET RESULTADO=?,DT_RESULTADO=?,CONCLUIDO='SIM',OPERADOR_LIGACAO=?,DATA_HORA_LIG=?,DATA_HORA_FIM=?,TELEFONE_LIGADO=? WHERE CODIGO=? AND OPERADOR=? AND (CONCLUIDO='NAO' OR CONCLUIDO IS NULL)",
			[
				c.resultId,
				now.slice(0, 10),
				actorId,
				started,
				now,
				phone,
				scheduleId,
				actorId,
			],
		),
	);
	const historyId = ack(
		await tx.execute(
			"INSERT INTO historico_cli (CAMPANHA,ATIVO_RECEP,OPERADOR,DATAHORA_INICIO,DATAHORA_FIM,RESULTADO,TELEFONE,OBSERVACAO,CLIENTE,CC_CODIGO) VALUES (?,'ATIVO',?,?,?,?,?,?,?,?)",
			[
				String(campaign["NOME"]).length <= 30
					? campaign["NOME"]
					: String(campaign["CODIGO"]),
				String(actor["LOGIN"] || actor["NOME"]).length <= 35
					? String(actor["LOGIN"] || actor["NOME"])
					: String(actorId),
				started,
				now,
				c.resultId,
				phone,
				c.observation,
				customer["CODIGO"],
				scheduleId,
			],
		),
	);
	if (!historyId) return conflict();
	if (c.phaseContactId)
		await tx.execute(
			"UPDATE historico_cli SET CODIGO_FASE_CONTATO=? WHERE CODIGO=?",
			[c.phaseContactId, historyId],
		);
	const selectedProposals = await lockProposals(
		tx,
		[
			...(c.cancelProposals ?? []).map((p) => p.id),
			...(c.sale?.proposalIds ?? []),
		],
		Number(current["CLIENTE"]),
	);
	await proposalEffects(tx, input, hash, current, selectedProposals);
	let saleId: number | null = null;
	if (c.sale) {
		const duplicate = await tx.execute<Row[]>(
			"SELECT CODIGO FROM compras WHERE DESCRICAO=? LIMIT 1 FOR UPDATE",
			[c.sale.description],
		);
		if (duplicate.length)
			return refuse("Já existe uma compra com esta descrição.");
		saleId = ack(
			await tx.execute(
				"INSERT INTO compras (CLIENTE,OPERADOR,DATA,DESCRICAO,VALOR,FORMA_PGTO) VALUES (?,?,?,?,?,?)",
				[
					customer["CODIGO"],
					actorId,
					now.slice(0, 10),
					c.sale.description,
					c.sale.value,
					c.sale.paymentMethod,
				],
			),
		);
		if (!saleId) return conflict();
		if (
			c.sale.proposalIds.some((id) =>
				c.cancelProposals?.some((p) => p.id === id),
			)
		)
			return refuse(
				"Uma proposta nao pode ser cancelada e vinculada a venda.",
			);
		if (c.sale.proposalIds.some((id) => !selectedProposals.has(id)))
			return conflict("A proposta mudou.");
		if (c.sale.proposalIds.length) {
			const linked = await tx.execute<{ affectedRows: number }>(
				`INSERT INTO propostas_compras (PROPOSTA,COMPRA) VALUES ${c.sale.proposalIds.map(() => "(?,?)").join(",")}`,
				c.sale.proposalIds.flatMap((id) => [id, saleId]),
			);
			if (linked.affectedRows !== c.sale.proposalIds.length)
				return conflict();
		}
	}
	await loyaltyEffects(tx, current, result, params, actorId, now);
	let successorScheduleId: number | null = null;
	if (next) {
		const owner =
			action === 1
				? { id: actorId, loyal: true }
				: c.delegateOperatorId
					? { id: c.delegateOperatorId, loyal: true }
					: await successorOwner(
							tx,
							customer,
							current,
							result,
							params,
							actorId,
						);
		const priority = enabled(result["PRIORIDADE"]) || Boolean(c.priority);
		const agenda =
			action === 1
				? priority
					? -200
					: -100
				: action === 8
					? -240
					: priority
						? -200
						: 0;
		const fid = action === 1 || action === 8 || owner.loyal ? "S" : null;
		const ownerId = owner.id;
		if (ownerId > 0) {
			const ownerState = await tx.execute<{ ATIVO: string }[]>(
				"SELECT ATIVO FROM operadores WHERE CODIGO=? FOR UPDATE",
				[ownerId],
			);
			if (ownerState[0]?.ATIVO !== "SIM")
				return conflict(
					"O responsável pelo reagendamento ficou indisponível.",
				);
		}
		const finalOwnerId =
			(enabled(policy["fidelize_on_sale"]) &&
				enabled(result["EVENDA"])) ||
			enabled(policy["first_contact_assignment"])
				? actorId
				: ownerId;
		await validateSchedule(
			tx,
			params,
			customer,
			result,
			next,
			now,
			finalOwnerId,
			action,
		);
		const phones =
			action === 1
				? [c.redialPhone!, "", ""]
				: [
						current["FONE1"] || "",
						current["FONE2"] || "",
						current["FONE3"] || "",
					];
		successorScheduleId = ack(
			await tx.execute(
				"INSERT INTO campanhas_clientes (CLIENTE,CAMPANHA,DT_AGENDAMENTO,CONCLUIDO,FONE1,FONE2,FONE3,DESC_FONE1,DESC_FONE2,DESC_FONE3,ORDEM,OPERADOR,OPERADOR_LIGACAO,AGENDA,FIDELIZA,DATA_HORA_LIG,DATA_HORA_FIM,DT_RESULTADO) VALUES (?,?,?,'NAO',?,?,?,?,?,?,?, ?,0,?,?,NULL,NULL,NULL)",
				[
					customer["CODIGO"],
					current["CAMPANHA"],
					next,
					...phones,
					action === 1 ? null : (current["DESC_FONE1"] ?? null),
					action === 1 ? null : (current["DESC_FONE2"] ?? null),
					action === 1 ? null : (current["DESC_FONE3"] ?? null),
					action === 1 && !enabled(params["EXIGIR_FASE_CONTATO"])
						? (current["ORDEM"] ?? 0)
						: 0,
					ownerId,
					agenda,
					fid,
				],
			),
		);
		if (!successorScheduleId) return conflict();
	}
	if (action === 6) {
		await tx.execute("UPDATE clientes SET ATIVO='NAO' WHERE CODIGO=?", [
			customer["CODIGO"],
		]);
		const history = await tx.execute<Row[]>(
			"SELECT CLIENTE FROM motivo_desativacao_cliente WHERE CLIENTE=? LIMIT 1 FOR UPDATE",
			[customer["CODIGO"]],
		);
		if (!history.length)
			ack(
				await tx.execute(
					"INSERT INTO motivo_desativacao_cliente (OPERADOR,CLIENTE,DATAHORA,MOTIVO) VALUES (?,?,?,?)",
					[
						actorId,
						customer["CODIGO"],
						now,
						c.observation || String(result["NOME"]),
					],
				),
			);
		if (enabled(params["HABILITAR_CLIENTES_BLOQUEADOS"]))
			ack(
				await tx.execute(
					"INSERT INTO cliente_bloqueado (CODIGO_CAMPANHA_CLIENTE,BLOQUEADO) VALUES (?,'N')",
					[scheduleId],
				),
			);
	} else
		await tx.execute(
			"UPDATE clientes SET ATIVO='SIM',OPERADOR_LOGIN=? WHERE CODIGO=?",
			[actor["LOGIN"], customer["CODIGO"]],
		);
	await tx.execute(
		"UPDATE clientes SET POSSUI_ORCAMENTO='N',POSSUI_VENDA='N',DT_ULTIMO_ORCAMENTO_VENDA=NULL WHERE CODIGO=?",
		[customer["CODIGO"]],
	);
	if (
		(enabled(policy["fidelize_on_sale"]) && enabled(result["EVENDA"])) ||
		enabled(policy["first_contact_assignment"])
	) {
		await tx.execute("UPDATE clientes SET OPERADOR=? WHERE CODIGO=?", [
			actorId,
			customer["CODIGO"],
		]);
		customer["OPERADOR"] = actorId;
		await tx.execute(
			"UPDATE campanhas_clientes SET OPERADOR=? WHERE CLIENTE=? AND CONCLUIDO='NAO'",
			[actorId, customer["CODIGO"]],
		);
	}
	if (enabled(params["FIDELIZACAO_ZERO"])) {
		const latest = (
			await tx.execute<Row[]>(
				"SELECT QTDE_FIDELIZAR,OPERADOR_CRIACAO FROM fidelizacoes WHERE CLIENTE=? ORDER BY CODIGO DESC LIMIT 1 FOR UPDATE",
				[customer["CODIGO"]],
			)
		)[0];
		if (
			latest &&
			Number(latest["QTDE_FIDELIZAR"]) === 0 &&
			Number(latest["OPERADOR_CRIACAO"]) === actorId
		)
			await tx.execute(
				"UPDATE campanhas_clientes SET OPERADOR=0,FIDELIZA=NULL WHERE CLIENTE=? AND CONCLUIDO='NAO'",
				[customer["CODIGO"]],
			);
	}
	await recompose(tx, customer, result, params, actorId, now);
	if (c.survey) {
		ack(
			await tx.execute(
				"INSERT INTO telephony_satisfaction_submissions (operation_id,schedule_id,actor_id,history_id,survey_json,created_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP())",
				[
					c.operationId,
					scheduleId,
					actorId,
					historyId,
					JSON.stringify(c.survey),
				],
			),
		);
		const a = await tx.execute<any>(
			`INSERT INTO pesquisa_satisfacao_avaliacao (CAMPCLI_CODIGO,PESQSAT_CODIGO,PESQSAT_AVALIACAO) VALUES ${c.survey.answers.map(() => "(?,?,?)").join(",")}`,
			c.survey.answers.flatMap((a) => [
				scheduleId,
				a.questionId,
				a.rating === null ? "" : String(a.rating),
			]),
		);
		if (a.affectedRows !== c.survey.answers.length) return conflict();
	}
	const receipt: FinishV2Receipt = {
		operationId: c.operationId,
		scheduleId,
		successorScheduleId,
		historyId,
		saleId,
		finishedAt: now,
	};
	await hooks.afterFinish?.(tx, {
		actorId,
		scheduleId,
		...(c.callId ? { callId: c.callId } : {}),
		successorScheduleId,
		finishedAt: now,
		historyId,
	});
	ack(
		await tx.execute(
			"INSERT INTO telephony_finish_operations (operation_id,actor_id,schedule_id,request_hash,result_json,created_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP())",
			[c.operationId, actorId, scheduleId, hash, JSON.stringify(receipt)],
		),
	);
	return receipt;
}

interface LockedProposal {
	id: number;
	scheduleId: number;
	value: string;
	status: string;
	customerId: number;
	campaignId: number;
	version: string;
}
async function lockProposals(
	tx: TenantTransaction,
	ids: number[],
	customerId: number,
): Promise<Map<number, LockedProposal>> {
	const ordered = [...new Set(ids)].sort((a, b) => a - b),
		map = new Map<number, LockedProposal>();
	if (!ordered.length) return map;
	const placeholders = ordered.map(() => "?").join(",");
	const rows = await tx.execute<Omit<LockedProposal, "version">[]>(
		`SELECT p.CODIGO AS id,p.LIGACAO AS scheduleId,CAST(p.VALOR AS CHAR) AS value,p.SITUACAO AS status,cc.CLIENTE AS customerId,cc.CAMPANHA AS campaignId FROM propostas p INNER JOIN campanhas_clientes cc ON cc.CODIGO=p.LIGACAO WHERE p.CODIGO IN (${placeholders}) ORDER BY p.CODIGO FOR UPDATE`,
		ordered,
	);
	if (
		rows.length !== ordered.length ||
		rows.some(
			(p) =>
				Number(p.customerId) !== Number(customerId) ||
				p.status !== "ATIVA",
		)
	)
		return conflict("A proposta mudou.");
	const links = await tx.execute<{ PROPOSTA: number }[]>(
		`SELECT PROPOSTA FROM propostas_compras WHERE PROPOSTA IN (${placeholders}) ORDER BY PROPOSTA FOR UPDATE`,
		ordered,
	);
	if (links.length) return conflict("A proposta ja possui compra vinculada.");
	const events = await tx.execute<{ proposal_id: number }[]>(
		`SELECT proposal_id FROM crm_proposal_events WHERE proposal_id IN (${placeholders}) ORDER BY proposal_id FOR UPDATE`,
		ordered,
	);
	for (const p of rows) {
		const revision = events.filter(
			(e) => Number(e.proposal_id) === Number(p.id),
		).length;
		const version = createHash("sha256")
			.update(
				JSON.stringify([
					tx.tenant,
					p.id,
					p.scheduleId,
					p.value,
					p.status,
					0,
					revision,
				]),
			)
			.digest("hex");
		map.set(Number(p.id), { ...p, version });
	}
	return map;
}
async function proposalEffects(
	tx: TenantTransaction,
	input: FinishV2Input,
	hash: string,
	current: Row,
	proposals: Map<number, LockedProposal>,
) {
	const c = input.command;
	if (c.proposalValue) {
		const id = ack(
			await tx.execute(
				"INSERT INTO propostas (LIGACAO,VALOR,SITUACAO) SELECT ?,?,'ATIVA' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM propostas WHERE LIGACAO=?)",
				[input.scheduleId, c.proposalValue, input.scheduleId],
			),
		);
		if (!id) return conflict();
		ack(
			await tx.execute(
				"INSERT INTO crm_proposal_events (operation_id,request_hash,proposal_id,schedule_id,actor_id,action,new_value,new_status,reason,customer_id,campaign_id,created_at) VALUES (?,?,?,?,?,'CREATE',?,'ATIVA','Finalizacao telefonica',?,?,UTC_TIMESTAMP())",
				[
					c.operationId,
					hash,
					id,
					input.scheduleId,
					input.actorId,
					c.proposalValue,
					current["CLIENTE"],
					current["CAMPANHA"],
				],
			),
		);
	}
	const cancellations = (c.cancelProposals ?? []).map((selected) => {
		const proposal = proposals.get(selected.id);
		if (!proposal || proposal.version !== selected.version)
			return conflict("Releia as propostas antes de cancelar.");
		return proposal;
	});
	if (cancellations.length) {
		const ids = cancellations.map((p) => p.id);
		const changed = await tx.execute<{ affectedRows: number }>(
			`UPDATE propostas SET SITUACAO='CANCELADA' WHERE CODIGO IN (${ids.map(() => "?").join(",")}) AND SITUACAO='ATIVA'`,
			ids,
		);
		if (changed.affectedRows !== ids.length) return conflict();
		const audit = await tx.execute<{ affectedRows: number }>(
			`INSERT INTO crm_proposal_events (operation_id,request_hash,proposal_id,schedule_id,actor_id,action,old_value,new_value,old_status,new_status,reason,customer_id,campaign_id,created_at) VALUES ${cancellations.map(() => "(?,?,?,?,?,'CANCEL',?,?,'ATIVA','CANCELADA',?,?,?,UTC_TIMESTAMP())").join(",")}`,
			cancellations.flatMap((p) => [
				c.operationId,
				hash,
				p.id,
				p.scheduleId,
				input.actorId,
				p.value,
				p.value,
				`Resultado ${c.resultId}; atendimento ${input.scheduleId}`,
				current["CLIENTE"],
				p.campaignId,
			]),
		);
		if (audit.affectedRows !== ids.length) return conflict();
	}
}
async function loyaltyEffects(
	tx: TenantTransaction,
	current: Row,
	result: Row,
	params: Row,
	actorId: number,
	now: string,
) {
	const latest = (
		await tx.execute<Row[]>(
			"SELECT CODIGO,QTDE_FIDELIZAR FROM fidelizacoes WHERE CLIENTE=? ORDER BY CODIGO DESC LIMIT 1 FOR UPDATE",
			[current["CLIENTE"]],
		)
	)[0];
	const effect = nextLoyalty({
		quantity: Number(latest?.["QTDE_FIDELIZAR"] ?? 0),
		previousId: Number(latest?.["CODIGO"] ?? 0),
		configured: Number(result["QTDE_FIDELIZARCOTACAO"] ?? 0),
		contact: enabled(result["ECONTATO"]),
		resultLoyalty: enabled(result["FIDELIZARCOTACAO"]),
		scheduleLoyalty: current["FIDELIZA"] === "S",
		zero: enabled(params["FIDELIZACAO_ZERO"]),
	});
	if (effect)
		ack(
			await tx.execute(
				"INSERT INTO fidelizacoes (cliente,cc_codigo,cod_origem,qtde_fidelizar,dt_criacao,operador_criacao) VALUES (?,?,?,?,?,?)",
				[
					current["CLIENTE"],
					current["CODIGO"],
					effect.origin,
					effect.quantity,
					now,
					actorId,
				],
			),
		);
	return effect;
}
async function successorOwner(
	tx: TenantTransaction,
	customer: Row,
	_current: Row,
	result: Row,
	params: Row,
	actorId: number,
): Promise<{ id: number; loyal: boolean }> {
	if (enabled(params["CARTEIRA_FIXA_OPERADOR"]))
		return { id: Number(customer["OPERADOR"]) || 0, loyal: true };
	if (enabled(result["FIDELIZARCOTACAO"]) || enabled(result["EVENDA"]))
		return { id: actorId, loyal: enabled(result["FIDELIZARCOTACAO"]) };
	const transfer = (
		await tx.execute<Row[]>(
			"SELECT CAST(t.DATA_HORA AS CHAR) AS transferred FROM transferencia_clientes t INNER JOIN transferencia_clientes_itens ti ON ti.CODIGO=t.CODIGO WHERE ti.CLIENTE=? ORDER BY t.DATA_HORA DESC LIMIT 1",
			[customer["CODIGO"]],
		)
	)[0];
	const latest = (
		await tx.execute<Row[]>(
			"SELECT QTDE_FIDELIZAR FROM fidelizacoes WHERE CLIENTE=? ORDER BY CODIGO DESC LIMIT 1",
			[customer["CODIGO"]],
		)
	)[0];
	if (Number(latest?.["QTDE_FIDELIZAR"]) > 0) {
		const contacts = await tx.execute<Row[]>(
			"SELECT cc.OPERADOR_LIGACAO,ca.UNIDADE,r.FIDELIZARCOTACAO,r.QTDE_FIDELIZARCOTACAO FROM campanhas_clientes cc INNER JOIN campanhas ca ON ca.CODIGO=cc.CAMPANHA INNER JOIN resultados r ON r.CODIGO=cc.RESULTADO WHERE cc.CLIENTE=? AND r.ECONTATO='SIM' AND (? IS NULL OR cc.DATA_HORA_LIG>?) ORDER BY cc.CODIGO DESC LIMIT 50",
			[
				customer["CODIGO"],
				transfer?.["transferred"] ?? null,
				transfer?.["transferred"] ?? null,
			],
		);
		for (let i = 0; i < contacts.length; i++) {
			const r = contacts[i]!;
			if (
				(Number(r["QTDE_FIDELIZARCOTACAO"]) > 0 &&
					i + 1 > Number(r["QTDE_FIDELIZARCOTACAO"])) ||
				(Number(r["UNIDADE"]) !== Number(customer["COD_UNIDADE"]) &&
					Number(r["OPERADOR_LIGACAO"]) !== actorId)
			)
				break;
			if (enabled(r["FIDELIZARCOTACAO"]))
				return { id: Number(r["OPERADOR_LIGACAO"]), loyal: true };
		}
	}
	return { id: Number(customer["OPERADOR"]) || 0, loyal: false };
}
async function recompose(
	tx: TenantTransaction,
	customer: Row,
	_result: Row,
	params: Row,
	actorId: number,
	now: string,
) {
	const cid = customer["CODIGO"];
	const guard =
		"cc.CLIENTE=? AND cc.CONCLUIDO='NAO' AND cc.OPERADOR<>-2 AND cc.AGENDA NOT IN (-250,-260,-270,-240) AND ca.TIPO<>'ATIVOS'";
	const before = await tx.execute<Row[]>(
		`SELECT cc.CODIGO,cc.OPERADOR,cc.FIDELIZA FROM campanhas_clientes cc INNER JOIN campanhas ca ON ca.CODIGO=cc.CAMPANHA WHERE ${guard} ORDER BY cc.CODIGO FOR UPDATE`,
		[cid],
	);
	if (enabled(params["CARTEIRA_FIXA_OPERADOR"])) {
		const ids = before
			.filter(
				(row) =>
					Number(row["OPERADOR"]) !== Number(customer["OPERADOR"]),
			)
			.map((row) => Number(row["CODIGO"]));
		if (ids.length)
			await tx.execute(
				`UPDATE campanhas_clientes SET OPERADOR=? WHERE CODIGO IN (${ids.map(() => "?").join(",")})`,
				[customer["OPERADOR"], ...ids],
			);
		return;
	}
	const fid = (
		await tx.execute<Row[]>(
			"SELECT f.QTDE_FIDELIZAR,cc.OPERADOR_LIGACAO,cc.DATA_HORA_LIG,ca.UNIDADE,op.ATIVO FROM fidelizacoes f INNER JOIN campanhas_clientes cc ON cc.CODIGO=f.CC_CODIGO INNER JOIN campanhas ca ON ca.CODIGO=cc.CAMPANHA LEFT JOIN operadores op ON op.CODIGO=cc.OPERADOR_LIGACAO WHERE f.CLIENTE=? ORDER BY f.CODIGO DESC LIMIT 1",
			[cid],
		)
	)[0];
	if (
		!fid ||
		Number(fid["QTDE_FIDELIZAR"]) <= 0 ||
		Number(fid["OPERADOR_LIGACAO"]) <= 0
	)
		return;
	const transfer = (
		await tx.execute<Row[]>(
			"SELECT CAST(t.DATA_HORA AS CHAR) AS transferred FROM transferencia_clientes t INNER JOIN transferencia_clientes_itens ti ON ti.CODIGO=t.CODIGO WHERE ti.CLIENTE=? ORDER BY t.DATA_HORA DESC LIMIT 1",
			[cid],
		)
	)[0];
	if (
		transfer &&
		(!sqlDate(fid["DATA_HORA_LIG"]) ||
			sqlDate(fid["DATA_HORA_LIG"])! <= String(transfer["transferred"]))
	)
		return;
	const anyPending = (
		await tx.execute<Row[]>(
			"SELECT OPERADOR FROM campanhas_clientes WHERE CLIENTE=? AND CONCLUIDO='NAO' ORDER BY CODIGO LIMIT 1",
			[cid],
		)
	)[0];
	if (
		Number(fid["OPERADOR_LIGACAO"]) !== Number(anyPending?.["OPERADOR"]) &&
		Number(fid["UNIDADE"]) !== Number(customer["COD_UNIDADE"])
	)
		return;
	const changes = before.filter(
		(row) =>
			(row["FIDELIZA"] !== "S" || Number(row["OPERADOR"]) === 0) &&
			(fid["ATIVO"] === "SIM" ||
				Number(fid["OPERADOR_LIGACAO"]) === Number(row["OPERADOR"])),
	);
	if (!changes.length) return;
	const ids = changes.map((row) => Number(row["CODIGO"])),
		placeholders = ids.map(() => "?").join(","),
		owner = fid["ATIVO"] === "SIM" ? Number(fid["OPERADOR_LIGACAO"]) : 0;
	await tx.execute(
		`INSERT INTO campanhas_clientes_log (CODIGO,DATA_HORA,OPERADOR,CAMPO,OLD_VALOR,NEW_VALOR,MODULO) SELECT CODIGO,?,?,'FIDELIZA',COALESCE(FIDELIZA,''),'S','WEB_FINISH_V2' FROM campanhas_clientes WHERE CODIGO IN (${placeholders})`,
		[now, actorId, ...ids],
	);
	await tx.execute(
		`UPDATE campanhas_clientes SET OPERADOR=?,FIDELIZA=IF(?='SIM','S',FIDELIZA) WHERE CODIGO IN (${placeholders})`,
		[owner, fid["ATIVO"], ...ids],
	);
}
async function validateSchedule(
	tx: TenantTransaction,
	params: Row,
	customer: Row,
	result: Row,
	next: string,
	now: string,
	actorId: number,
	action: number,
) {
	if ([2, 7, 8].includes(action)) {
		const max = Number(params["DIAS_LIMITE_AGENDAMENTO"] ?? 0);
		if (
			max > 0 &&
			new Date(next.replace(" ", "T") + "Z").getTime() -
				new Date(now.replace(" ", "T") + "Z").getTime() >
				max * 86400000
		)
			return refuse("O agendamento excede o limite de dias.");
		const count = (
			await tx.execute<Row[]>(
				"SELECT COUNT(*) AS total FROM campanhas_clientes WHERE OPERADOR=? AND CONCLUIDO='NAO' AND DATE(DT_AGENDAMENTO)=?",
				[actorId, next.slice(0, 10)],
			)
		)[0];
		if (
			enabled(params["BLOQ_LIMITE_AGENDAMENTO_DIA"]) &&
			Number(params["LIMITE_AGENDAMENTO_DIA"]) > 0 &&
			Number(count?.["total"]) >= Number(params["LIMITE_AGENDAMENTO_DIA"])
		)
			return refuse("O limite diário de agendamentos foi atingido.");
		if (enabled(params["VALIDA_AGENDAMENTOS"])) {
			const close = (
				await tx.execute<Row[]>(
					"SELECT COUNT(*) AS total FROM campanhas_clientes WHERE OPERADOR=? AND CONCLUIDO='NAO' AND DT_AGENDAMENTO BETWEEN ? AND DATE_ADD(?,INTERVAL 5 MINUTE)",
					[actorId, next, next],
				)
			)[0];
			if (Number(close?.["total"]) > 8)
				return refuse(
					"Há muitos agendamentos próximos. Escolha outro horário.",
				);
		}
	}
	if (
		!enabled(result["EVENDA"]) &&
		enabled(params["BLOQUEAR_AGENDAMENTO_FORA_PERIODO_RECOMPRA"]) &&
		sqlDate(customer["DATA_ULT_COMPRA"])
	) {
		const days = Math.floor(
			(new Date(next.replace(" ", "T") + "Z").getTime() -
				new Date(
					sqlDate(customer["DATA_ULT_COMPRA"])!.replace(" ", "T") +
						"Z",
				).getTime()) /
				86400000,
		);
		const portfolio = (
			await tx.execute<{ TIPO: string; INATIVOS_RECENTES: number }[]>(
				"SELECT ca.TIPO,u.INATIVOS_RECENTES FROM clientes c INNER JOIN campanhas ca ON ca.CODIGO=c.COD_CAMPANHA LEFT JOIN unidades u ON u.CODIGO=ca.UNIDADE WHERE c.CODIGO=?",
				[customer["CODIGO"]],
			)
		)[0];
		const limit =
			portfolio?.TIPO === "ATIVOS"
				? Number(customer["PERIODO_RECOMPRA"])
				: portfolio?.TIPO === "INAT_R"
					? Number(portfolio.INATIVOS_RECENTES) - 30
					: null;
		if (
			limit !== null &&
			days > limit &&
			next.slice(0, 10) >
				new Date(
					new Date(now.replace(" ", "T") + "Z").getTime() + 86400000,
				)
					.toISOString()
					.slice(0, 10)
		)
			return refuse(
				"O agendamento ultrapassa o período de recompra permitido.",
			);
	}
}
