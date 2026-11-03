/** Mirrored by instances-service; signed commands accept these exact templates only. */
export const proposalTables = [
	"propostas",
	"propostas_compras",
	"crm_proposal_events",
	"campanhas_clientes",
	"operadores",
];
const guard =
	"p.CODIGO=? AND p.LIGACAO=? AND CAST(p.VALOR AS CHAR)=? AND BINARY p.SITUACAO=BINARY ? AND p.SITUACAO='ATIVA' AND NOT EXISTS (SELECT 1 FROM propostas_compras pc WHERE pc.PROPOSTA=p.CODIGO) AND EXISTS (SELECT 1 FROM operadores op WHERE op.CODIGO=? AND op.ATIVO='SIM' AND op.NIVEL='ADMIN') AND (SELECT COUNT(*) FROM crm_proposal_events ev WHERE ev.proposal_id=p.CODIGO)=?";
export const changeValueSql = `UPDATE propostas p SET p.VALOR=? WHERE ${guard}`;
export const cancelSql = `UPDATE propostas p SET p.SITUACAO='CANCELADA' WHERE ${guard}`;
export const deleteSql = `DELETE p FROM propostas p WHERE ${guard}`;
export const eventSql =
	"INSERT INTO crm_proposal_events (operation_id,request_hash,proposal_id,schedule_id,actor_id,action,old_value,new_value,old_status,new_status,reason,customer_id,campaign_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())";
export const createSql =
	"INSERT INTO propostas (LIGACAO,VALOR,SITUACAO) SELECT ?,?,'ATIVA' WHERE NOT EXISTS (SELECT 1 FROM propostas p WHERE p.LIGACAO=?)";
export const createEventSql =
	"INSERT INTO crm_proposal_events (operation_id,request_hash,proposal_id,schedule_id,actor_id,action,new_value,new_status,reason,customer_id,campaign_id,created_at) SELECT ?,?,p.CODIGO,p.LIGACAO,?,'CREATE',CAST(p.VALOR AS CHAR),'ATIVA','Finalizacao telefonica',cc.CLIENTE,cc.CAMPANHA,UTC_TIMESTAMP() FROM propostas p INNER JOIN campanhas_clientes cc ON cc.CODIGO=p.LIGACAO WHERE p.LIGACAO=?";
export const finishCancelSql =
	"UPDATE propostas p SET p.SITUACAO='CANCELADA' WHERE p.CODIGO=? AND p.LIGACAO=? AND CAST(p.VALOR AS CHAR)=? AND BINARY p.SITUACAO=BINARY ? AND p.SITUACAO='ATIVA' AND NOT EXISTS (SELECT 1 FROM propostas_compras pc WHERE pc.PROPOSTA=p.CODIGO) AND EXISTS (SELECT 1 FROM campanhas_clientes old_call INNER JOIN campanhas_clientes current_call ON current_call.CLIENTE=old_call.CLIENTE WHERE old_call.CODIGO=p.LIGACAO AND current_call.CODIGO=? AND current_call.OPERADOR=?) AND (SELECT COUNT(*) FROM crm_proposal_events ev WHERE ev.proposal_id=p.CODIGO)=?";
