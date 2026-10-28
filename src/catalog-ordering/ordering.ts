/** Keep byte-for-byte identical in instances, marketing and customers. Never execute stored SQL. */
export const orderExpressions = {
	TIPODEAGENDAMENTO: "cc.AGENDA ASC",
	PRIORIDADECAMPANHA: "c.PRIORIDADE ASC",
	DATAAGENDAMENTO:
		"IF(cc.DT_AGENDAMENTO='2011-11-08 13:55:31',DATE_ADD(NOW(),INTERVAL 1 YEAR),cc.DT_AGENDAMENTO) ASC",
	CIDADES:
		"IFNULL((SELECT MAX(ct.ORDEM) FROM cidades ct WHERE ct.NOME=c_.CIDADE AND ct.UF=c_.ESTADO),999999999) ASC",
	ESTADOS:
		"COALESCE((SELECT MAX(IF(u.ORDEM>0,u.ORDEM,NULL)) FROM uf u WHERE u.UF=c_.ESTADO),9999999) ASC",
	SEGMENTOS:
		"COALESCE((SELECT MAX(IF(s.ordem>0,s.ordem,NULL)) FROM segmentos s WHERE s.CODIGO=c_.SEGMENTO),999999999) ASC",
	POTENCIAL: "c_.POTENCIAL DESC",
	CADASTRO: "cc.ORDEM ASC",
} as const;
export type OrderCriterion = keyof typeof orderExpressions;
export function parseOrder(input: unknown): OrderCriterion[] {
	if (
		!Array.isArray(input) ||
		!input.length ||
		input.length > 8 ||
		input.some(
			(item) =>
				typeof item !== "string" ||
				!Object.hasOwn(orderExpressions, item),
		) ||
		new Set(input).size !== input.length
	)
		throw new Error("INVALID_ORDER_CRITERIA");
	return input as OrderCriterion[];
}
export function compileOrder(
	input: OrderCriterion[],
	cityMode: "S" | "N" = "N",
) {
	let geographic = false;
	const expressions: string[] = [];
	for (const key of input) {
		if (
			cityMode === "S" &&
			!geographic &&
			(key === "CIDADES" || key === "ESTADOS")
		) {
			expressions.push(
				"COALESCE((SELECT MAX(ct.ORDEMCIDADE) FROM cidades ct WHERE ct.NOME=c_.CIDADE AND ct.UF=c_.ESTADO),999999999) ASC",
			);
			geographic = true;
		}
		expressions.push(orderExpressions[key]);
	}
	return [...expressions, "cc.CODIGO ASC"].join(",");
}
