# Escopo global de pausa do operador

Estado único por `(tenant, operadores.CODIGO)`: `telephony_operator_state` e histórico/recibos existentes. Não alterar presença/socket nem copiar pausa para um User central. `pause_all_channels` ausente ou0 mantém o contrato telefônico legado; `enabled=1`, preflight_hash real válido e `pause_all_channels=1` habilitam a política de novas entradas dos demais canais.

Aplicação explícita da policy: `docs/sql/20261116-operator-pause-all-channels.sql`, compatível MySQL5.5/8. Também aplicar exatamente uma variante do cutoff, após conferir versão real e ausência da coluna: `20261116-operator-pause-cutoff-mysql55.sql` usa DATETIME; `20261116-operator-pause-cutoff-mysql56plus.sql` exige MySQL>=5.6.4 e usa DATETIME(3). Este código não roda DDL ou ativa tenant. A revisão global deve registrar código de cada writer, rota/whitelist do tenant no WhatsApp, engines e metadata, teste concorrente e nova revisão real. Rollback de escopo: `pause_all_channels=0`, sem apagar estado/segmentos/recibos/cutoff; o fluxo telefônico continua conforme enabled/preflight_hash.

WhatsApp deve estar em tenant-sql no MESMO CRM da autoridade. Toda atribuição/criação/transferência nova deve compartilhar o lock da policy (`LOCK IN SHARE MODE`) e do operador (`telephony_operator_state FOR UPDATE`) com a pausa, e gravar o chat na mesma transação nativa. Não substituir isso por um GET seguido de write central, lease com expiração ou mudança automática de modo/G22. Central/separado não é capability global suportada. Falha/indefinição quando o opt-in está ativo bloqueia novas entradas, sem mexer em mensagens/atendimentos existentes.

`pending` e `paused` impedem novas atribuições. Responder e concluir chats já atribuídos continuam permitidos. Para chats compartilhados sem atribuição, o writer permite resposta humana somente quando o chat começou estritamente antes de `telephony_operator_state.unavailable_since`; não basta o chat existir no momento do envio. Timestamp ausente ou empatado é ambíguo e recusa o novo envio enquanto indisponível. Retomar recupera a disponibilidade, sem remover chats. `after_attendance` permanece ancorado exclusivamente à agenda telefônica atual (`afterAttendanceScope="telephony_schedule"`); não espera fechar todos os chats. Rediscar a mesma agenda pendente é continuação do atendimento existente; outra discagem é recusada. Cancelar pendência/Retomar reabre a elegibilidade. Pausa imediata aceita chats WhatsApp abertos, mas não uma chamada telefônica ativa.

`unavailable_since` é UTC, definido na entrada available→pending/paused, preservado ao concluir a agenda (P04), trocar motivo e repetir operações, e limpo ao Retomar/Cancelar. Não derivar de updated_at. O clock desse campo consulta o COLUMN_TYPE real: datetime(3..6) usa UTC_TIMESTAMP(3); datetime legado usa UTC_TIMESTAMP(), sem sintaxe fracionária no MySQL5.5. Os demais relógios de chamadas/segmentos continuam iguais. MySQL5.5 mantém precisão de segundos: pode recusar um chat compartilhado aberto instantes antes da pausa no mesmo segundo, pois igualdade é conservadora. MySQL>=5.6.4 com DATETIME(3) reduz essa janela a um milissegundo. `unavailableSince` no status preserva a precisão como ISO. Nova policy global sem a coluna retorna `scopeStorageReady=false` e recusa nova pausa; não inventa um cutoff para pausas antigas sem evidência.

O runtime lê a policy com lock compartilhado antes do estado, mantendo revisão estável até COMMIT. Um comando novo global exige `scopeVerified="tenant-sql-v1"` e `scopePolicyRevision` iguais à revisão corrente, introduzidos pelo customers depois de verificar a capability do tenant. Estes campos não entram no hash semântico do recibo. Repetir UUID+conteúdo devolve o recibo original; o customers sempre relê o estado atual antes de responder, sem atribuir escopo novo a um recibo velho.

## Leitura interna advisory

Endpoint HMAC existente: POST `/api/instances/:instance/transactions`.

```json
{"operation":"operator.pause.eligibility","actorIds":[1,2,3]}
```

Somente o assinador servidor-a-servidor pode chamar; nunca enviar segredo ao frontend. IDs positivos até INT_MAX, máximo200 por lote, únicos e ordenados. Não há SQL nem seletores de outro tenant no corpo. Retorna requestedScope, policyRevision, `advisory:true` e entries `{actorId,active,state,version,newAssignmentsAllowed}`. OFF/coluna ausente preserva a elegibilidade legada; global ON nega paused/pending/estado desconhecido/inativo/inexistente. Erros não viram disponibilidade. Esse snapshot é filtro de apresentação; só a transação do writer garante admissão.
