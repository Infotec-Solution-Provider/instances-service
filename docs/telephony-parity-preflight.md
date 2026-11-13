# Telefonia web: conferência e ativação por tenant

Este roteiro prepara P04/P05/P13/P16/Q01. Não executa migração, publicação, acesso remoto ou ativação. Toda conferência deve identificar conexão, tenant, banco, versão MySQL, responsável e revisão dos serviços. Homologação e produção têm evidências e aprovações separadas.

## 1. Confirmar o banco e inventariar o legado

Use uma conexão previamente autorizada para o CRM selecionado. Primeiro confira a identidade; não escolha o banco por semelhança de nome.

```sql
SELECT DATABASE() AS crm_database, VERSION() AS mysql_version,
       @@hostname AS mysql_host, @@port AS mysql_port,
       @@GLOBAL.time_zone AS global_zone, @@SESSION.time_zone AS session_zone,
       @@GLOBAL.system_time_zone AS system_zone, NOW() AS crm_now,
       UTC_TIMESTAMP() AS utc_now;

SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND (TABLE_NAME LIKE 'telephony_%' OR TABLE_NAME IN (
    'operadores','operadores_config_sip','clientes','campanhas','campanhas_clientes',
    'resultados','parametros','historico_cli','fidelizacoes','transferencia_clientes',
    'transferencia_clientes_itens','propostas','propostas_compras','crm_proposal_events',
    'compras','pesquisa_satisfacao','pesquisa_satisfacao_avaliacao',
    'motivo_desativacao_cliente','cliente_bloqueado','campanhas_clientes_log',
    'motivos_pausa','fase_contato','unidades','login_ativo_receptivo','alteracoes_clientes'))
ORDER BY TABLE_NAME;

SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND (TABLE_NAME LIKE 'telephony_%' OR TABLE_NAME IN (
    'clientes','campanhas_clientes','resultados','parametros','fidelizacoes',
    'historico_cli','propostas','propostas_compras','compras','motivos_pausa',
    'fase_contato','unidades','operadores_config_sip','login_ativo_receptivo'))
ORDER BY TABLE_NAME, ORDINAL_POSITION;

SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND (TABLE_NAME LIKE 'telephony_%' OR TABLE_NAME IN (
    'campanhas_clientes','fidelizacoes','propostas','propostas_compras',
    'transferencia_clientes','transferencia_clientes_itens','alteracoes_clientes'))
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;
```

Compare o resultado com `finishV2Tables` em `src/telephony-finish-v2/finish.ts`, `runtimeTables` em `src/telephony-runtime/contract.ts` e a tabela adicional `telephony_web_sessions`. Todas as tabelas participantes das transações devem existir e ser InnoDB. Não converter engines automaticamente. O runtime e o P04 fazem a verificação novamente dentro da transação.

Revise também `SHOW CREATE TABLE` de cada tabela participante. Exemplos para os pontos mais sensíveis:

```sql
SHOW CREATE TABLE campanhas_clientes;
SHOW CREATE TABLE fidelizacoes;
SHOW CREATE TABLE historico_cli;
SHOW CREATE TABLE propostas;
SHOW CREATE TABLE propostas_compras;
SHOW CREATE TABLE pesquisa_satisfacao_avaliacao;
SHOW CREATE TABLE operadores_config_sip;
SHOW CREATE TABLE clientes;
```

Confira chaves, auto incrementos, enumerações, precisão monetária, limites de texto e defaults. Em particular: `campanhas_clientes` precisa permitir uma sucessora nova sem reutilizar a linha concluída; `fidelizacoes` precisa preservar a cadeia `COD_ORIGEM`; vínculos de propostas e avaliações devem corresponder às colunas usadas pelo código. Os cinco campos financeiros de `clientes` permanecem consulta/importação; vencimento deve ser `DATE` para a capacidade de importação ser oferecida.

Verifique planos e índices para cliente/agendas (`CLIENTE,CODIGO`), operador/fila (`OPERADOR,CONCLUIDO,DT_AGENDAMENTO`), resultados do dia (`OPERADOR_LIGACAO,DT_RESULTADO`), fidelizações (`CLIENTE,CODIGO`), propostas por ligação, vínculos por proposta e transferências por cliente. Não adicione unicidade antes de conferir duplicatas históricas:

```sql
SELECT LIGACAO, COUNT(*) AS quantity
FROM propostas GROUP BY LIGACAO HAVING COUNT(*) > 1 LIMIT 100;
SELECT PROPOSTA, COUNT(*) AS quantity
FROM propostas_compras GROUP BY PROPOSTA HAVING COUNT(*) > 1 LIMIT 100;
SELECT CLIENTE, COUNT(*) AS quantity
FROM campanhas_clientes GROUP BY CLIENTE HAVING COUNT(*) > 2000 LIMIT 100;
```

Execute estas consultas somente após confirmar os nomes físicos com `SHOW CREATE TABLE`.

## 2. Identificar efeitos externos antes de migrar

```sql
SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, EVENT_MANIPULATION,
       ACTION_TIMING, ACTION_STATEMENT
FROM information_schema.TRIGGERS
WHERE TRIGGER_SCHEMA = DATABASE()
ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME;

SELECT ROUTINE_NAME, ROUTINE_TYPE, SQL_DATA_ACCESS, ROUTINE_DEFINITION
FROM information_schema.ROUTINES
WHERE ROUTINE_SCHEMA = DATABASE()
ORDER BY ROUTINE_NAME;

SELECT EVENT_NAME, STATUS, EVENT_TYPE, EXECUTE_AT,
       INTERVAL_VALUE, INTERVAL_FIELD, EVENT_DEFINITION
FROM information_schema.EVENTS
WHERE EVENT_SCHEMA = DATABASE()
ORDER BY EVENT_NAME;

SELECT TABLE_NAME, COLUMN_NAME, CONSTRAINT_NAME,
       REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
FROM information_schema.KEY_COLUMN_USAGE
WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION;
```

Complete a inspeção das rotinas identificadas com `SHOW CREATE PROCEDURE nome_revisado` ou `SHOW CREATE FUNCTION nome_revisado`. Não chame procedimentos para descobrir o que fazem. Registre também executores Delphi, ExecutorFidelizacao, importadores, jobs e integrações que gravem nas mesmas tabelas. O novo fluxo recusa triggers não revisados nas tabelas verificadas; marcar um hash não dispensa essa proteção.

## 3. Revisar e preparar as migrações

Os arquivos abaixo são a fonte do DDL. Não executar novamente um `ALTER` só porque o arquivo existe; compare primeiro o esquema atual. A migração `allow_auto_answer` usa `ADD COLUMN` simples, compatível com MySQL 5.5 e sem reaplicação automática.

| Origem            | Arquivo                                             | Finalidade                                                                |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| instances-service | `docs/sql/20261113-telephony-runtime.sql`           | Sessões de chamadas, eventos, avaliações, pausas, recibos e intenções PBX |
| instances-service | `docs/sql/20261113-telephony-web-sessions.sql`      | Intervalos observados da presença web                                     |
| customers-service | `docs/sql/20261113-telephony-finish-v2.sql`         | Política e recibos P04                                                    |
| customers-service | `docs/sql/20261103-crm-proposal-events.sql`         | Auditoria de propostas, se ausente                                        |
| customers-service | `docs/sql/20261103-telephony-satisfaction.sql`      | Recibos de satisfação, se ausentes                                        |
| customers-service | `docs/sql/20261019-telephony-finish.sql`            | Histórico/recibos do fluxo anterior; revisar somente o que faltar         |
| instances-service | `docs/sql/20261103-crm-client-block-queue.sql`      | Cadastro legado de bloqueio, somente se ausente                           |
| users-service     | `migrations/20261113_001_telephony_extensions.sql`  | Diretório Nome/Ramal do mesmo PABX, sem provisionar ramais                |
| users-service     | `migrations/20261113_002_telephony_auto_answer.sql` | Autorização do tenant para atendimento automático, padrão desativado      |

Confira as migrações anteriores de `telephony_webrtc_settings` e gateway em `users-service/migrations/20260922_001_telephony_webrtc_settings.sql` e `20260930_001_telephony_webrtc_gateway.sql`. Um esquema ausente deve resultar em capacidade indisponível ou recurso desativado; não preencher indicadores com zeros fictícios nem ativar opções de áudio automaticamente.

Após qualquer DDL autorizado, repita o inventário, registre hashes dos arquivos aplicados e guarde a evidência em `planejamento/`. Valide o conjunto integrado na branch `homolog` de cada serviço. Reexecute os testes de P04/runtime, métricas, privacidade financeira e SIP; os ensaios locais usam bancos descartáveis próprios nas portas 13555/13480 e não demonstram compatibilidade de um CRM ainda não inventariado.

## 4. Fazer a troca exclusiva do tenant

1. Registrar backup e roteiro de recuperação com responsável e janela. Manter as políticas desativadas durante a preparação.
2. Concluir atendimentos em andamento e parar novas gravações de finalização do Delphi e dos executores do tenant. Interromper também processos automáticos que concorram com fidelização/reposição. Confirmar ausência de requisições antigas em andamento antes de liberar o novo escritor.
3. Publicar o conjunto compatível de instances/customers/users/frontend, conferir artefatos e saúde e repetir o inventário após a publicação. O caminho antigo web também possui bloqueio transacional quando o P04 novo está habilitado.
4. Produzir um documento de conferência com banco, DDL/índices/engines, rotinas/efeitos revisados, parâmetros, calendário CRM, commits, artefatos e resultado dos ensaios. Calcular seu SHA-256. Um hash com 64 caracteres é um identificador de revisão; o sistema não reconstrói essa auditoria automaticamente.
5. Somente depois da revisão do tenant e na janela de migração definida, preencher o hash e ativar o tenant. Não ativar venda, mudança de motivo ou autoatendimento por consequência da troca.

As leituras de conferência das políticas, após criar as tabelas, são:

```sql
SELECT id, enabled, allow_change_reason, preflight_hash
FROM telephony_runtime_policy WHERE id = 1;
SELECT id, enabled, sale_enabled, fidelize_on_sale,
       first_contact_assignment, exclusive_writer, preflight_revision
FROM telephony_finish_policy WHERE id = 1;
SELECT id, enabled, allow_auto_answer
FROM telephony_webrtc_settings WHERE id = 1;
```

`enabled=1` sozinho não libera o conjunto. O runtime exige `preflight_hash` válido; o P04 exige `preflight_revision` válido e `exclusive_writer=1`, além das condições transacionais de schema. `exclusive_writer` é uma declaração operacional: não encerra processos Delphi. `sale_enabled`, `fidelize_on_sale` e `first_contact_assignment` têm decisões independentes e começam desativados.

Os comandos abaixo ilustram a ativação **posterior à revisão**, não devem ser executados como preflight. Substituir os marcadores pelos hashes reais revisados; não usar um valor fictício para ultrapassar o gate.

```sql
UPDATE telephony_runtime_policy
SET preflight_hash = '<SHA256_REAL_DA_REVISAO_RUNTIME>', enabled = 1
WHERE id = 1 AND enabled = 0;

UPDATE telephony_finish_policy
SET preflight_revision = '<SHA256_REAL_DA_REVISAO_P04>',
    exclusive_writer = 1, enabled = 1
WHERE id = 1 AND enabled = 0;
```

## 5. Manter PBX e autoatendimento sob adesão explícita

O diretório é exclusivo do CRM/PABX do tenant. Confirme a identidade da central, transporte SIP, ramais dos operadores e destinos cadastrados. O CRUD do diretório é administrativo; operadores podem selecionar um destino ou digitar um ramal interno autorizado pelo dialplan. Ele não cria nem configura ramais na central.

```sql
SELECT id, name, extension, version FROM telephony_extensions ORDER BY id;
SELECT operator_id, queue_name, member_interface, enabled
FROM telephony_pbx_members ORDER BY operator_id, queue_name, member_interface;
SELECT id, operator_id, queue_name, member_interface, paused, status, detail
FROM telephony_pbx_intents ORDER BY id DESC LIMIT 100;
```

Não inferir `queue_name` ou `member_interface` a partir do número do ramal. Inventariar os valores reais em uma leitura autorizada da central e cadastrar cada associação com `enabled=0`; habilitar somente as associações revisadas. Sem associação habilitada, a pausa continua registrada apenas no CRM. Resposta de envio AMI não equivale a pausa confirmada: o estado deve ser observado na central; falhas ou ausência de observação permanecem explícitas. Nenhuma chamada AMI é feita por este roteiro.

Autoatendimento exige as duas escolhas: autorização do tenant (`allow_auto_answer`) e adesão do operador no navegador. Ambos começam desativados. Durante pausa, autoatendimento fica suspenso; atender manualmente encerra a pausa conforme a regra do runtime. Preferências de dispositivos/processamento de áudio são locais ao navegador e não devem transportar credenciais SIP para relatórios de validação.

Depois de habilitar, validar com chamadas de teste autorizadas: saída, recebida, transferência cega, encerramento e avaliação opcional; finalização manual e idempotente; sucessora separada; pausa pendente somente após salvar; motivo/limite/excesso e retorno; sincronização após queda e privacidade financeira com ADMIN e operador. Confirmar os recibos e os resultados CRM antes de encerrar a janela.

Se houver necessidade de retorno após gravações novas, parar escritores, preservar recibos/eventos e reconciliar agendas, históricos, propostas e fidelizações antes de reabrir o Delphi. Desligar flags isoladamente não desfaz dados já gravados nem demonstra compatibilidade do legado.
