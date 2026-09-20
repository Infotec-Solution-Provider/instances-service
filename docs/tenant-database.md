# Fundação transacional dos tenants

Etapa T05 do plano INF-20260918-001. A biblioteca em `src/tenant-database/` e a fábrica `getTenantDatabase()` são o caminho para novos repositórios executados dentro do instances-service. Não modificam `PoolsService`, `ClientPool`, a rota SQL legada nem as tabelas existentes. Nenhuma conexão é aberta antes da primeira operação; não existe DDL ou cópia no startup.

## Contrato de uso

O contexto do tenant deve vir da autorização e do roteamento confiáveis do servidor. O catálogo resolve host, banco e credenciais; a requisição não pode informar esses campos. O adaptador padrão consulta `ServersService` e exige correspondência exata de `instanceName`.

Um repositório de domínio usa uma chamada, declara todas as tabelas lidas/escritas e aguarda cada comando sequencialmente:

```ts
import { getTenantDatabase } from "../services/tenant-database.service";

// Exemplo de integração futura; depende dos schemas e contratos de IDs do domínio.
const database = getTenantDatabase();
await database.transaction(authorizedTenant, "messages.enqueue", ["wpp_messages", "wpp_outbox"], async transaction => {
  await transaction.execute(
    "INSERT INTO wpp_messages (id, body) VALUES (?, ?)",
    [reservedMessageId, body],
  );
  await transaction.execute(
    "INSERT INTO wpp_outbox (message_id, operation_key) VALUES (?, ?)",
    [reservedMessageId, operationKey],
  );
});
```

Esse exemplo **não é um schema implementado**. A camada gerencia conexão, BEGIN, COMMIT e ROLLBACK. `execute` recebe SQL controlado pelo código do repositório, nunca SQL recebido do navegador. Não é um parser de autorização nem uma sandbox: nomes de tabelas, referências entre schemas, triggers e funções precisam ser revisados no repositório. As tabelas declaradas devem cobrir todas as operações, inclusive as indiretas; todas precisam ser InnoDB. O catálogo deve identificar corretamente bancos distintos por tenant; compartilhar o mesmo schema exige um contrato adicional de isolamento ainda não implementado.

As tabelas declaradas recebem locks de metadados durante a transação e sua engine é conferida. Isso impede uma troca de engine após a conferência enquanto a transação continua aberta. DDL, BEGIN/COMMIT manuais, comandos simultâneos e falhas SQL capturadas pelo callback invalidam a transação. Não enviar mensagens, chamar provedores ou produzir outros efeitos externos dentro do callback.

SQL com parâmetros usa `mysql2.execute`. O pool novo usa `utf8mb4_unicode_ci`, resultados de datas como strings, timezone UTC e BIGINT como string; cada sessão ativa modo estrito. Testado com MySQL 5.5.62 e 8.0, inclusive default do banco Latin1 e `NO_BACKSLASH_ESCAPES`. Não altera o pool Latin1 legado. Tipos de datas, JSON, índices, collation de identificadores e DDL dos domínios continuam responsabilidade dos próximos adaptadores.

Paginar leituras por chave e limitar colunas/bytes no repositório. O limite de parâmetros desta camada não limita os bytes de resultados já transferidos pelo driver. Sem paginação de domínio, uma consulta SELECT grande ainda pode consumir memória.

## Resultado incerto e encerramento

- `COMMITTED`: o driver confirmou COMMIT; só então o retorno do callback é entregue ao chamador.
- `NOT_COMMITTED`: a camada não enviou COMMIT. Falha durante a operação provoca rollback ou descarte da conexão. Isso pressupõe o contrato de tabelas InnoDB e ausência de efeitos externos/não transacionais.
- `UNKNOWN` / `TENANT_COMMIT_UNKNOWN`: COMMIT foi enviado e sua confirmação falhou/expirou. A conexão é descartada e o callback **não é repetido**. Consultar o registro durável da operação antes de decidir qualquer próximo efeito.

Não há retry automático, nem recibo de idempotência genérico nesta entrega. Cada domínio deve registrar a chave/resultado na mesma transação que seus dados e implementar reconciliação. `UNKNOWN` não autoriza reenvio ao WhatsApp. O nome de operação passado ao método serve para diagnóstico; não é uma chave de deduplicação.

Timeout revoga o acesso do callback à sessão e destrói a conexão. Encerrar o socket não garante que o servidor interrompa instantaneamente uma consulta ou rollback; controlar índices, tamanho dos lotes e carga continua necessário. Em shutdown, parar admissão HTTP/workers, drenar seus trabalhos e chamar `closeTenantDatabase()`. A biblioteca fecha a fila, aguarda suas operações limitadas por prazo e encerra pools. A integração com o ciclo de vida da API deve acompanhar a primeira rota de domínio; a biblioteca ainda não é chamada pelo runtime legado.

## Orçamento por processo

| Variável | Padrão | Limite controlado |
|---|---:|---|
| TENANT_DB_CONNECTIONS_PER_TENANT | 2 | Conexões/execuções simultâneas por tenant |
| TENANT_DB_ACTIVE_GLOBAL | 16 | Operações admitidas simultaneamente |
| TENANT_DB_ACTIVE_PER_SERVER | 4 | Operações simultâneas por servidor |
| TENANT_DB_PENDING_GLOBAL | 64 | Fila global e destinos ainda em resolução |
| TENANT_DB_PENDING_PER_TENANT | 8 | Espera por tenant |
| TENANT_DB_PENDING_PER_SERVER | 16 | Espera pelo mesmo servidor |
| TENANT_DB_MAX_POOLS | 16 | Pools alocados, incluindo os em encerramento |
| TENANT_DB_MAX_POOLS_PER_SERVER | 4 | Pools alocados por servidor |
| TENANT_DB_WAIT_MS | 2000 | Prazo por etapa: catálogo, admissão, pool e aquisição |
| TENANT_DB_TRANSACTION_MS | 5000 | Prazo total da sessão transacional, incluindo callback e commit |
| TENANT_DB_IDLE_MS | 60000 | Expiração de pools sem uso |
| TENANT_DB_MAX_STATEMENTS | 100 | Comandos de domínio por transação |
| TENANT_DB_MAX_PARAMETER_BYTES | 1048576 | Soma dos parâmetros de domínio por transação |

Os valores são inteiros positivos validados. SQL tem limite de 64 KiB por comando e até 10.000 parâmetros. Os tempos de espera são por etapa e podem se somar; rollback/fechamento também têm prazos próprios.

Com os padrões, os slots reservam até 32 conexões de pools novos por processo, no máximo 8 por servidor, com no máximo 16/4 operações simultâneas. Multiplicar por processos/hosts e somar pools legados e outros serviços antes de usar em produção. Esses limites não são uma homologação de capacidade do servidor.

O agrupamento padrão é host normalizado + porta. Endereços diferentes para o mesmo servidor físico precisam de `serverGroup` comum em um resolver confiável; o catálogo atual ainda não armazena esse agrupamento. Pools com uso ativo não são substituídos quando a configuração muda. Alterar destino exige pausa/drenagem: esta camada não substitui o roteamento versionado e os bloqueios de escrita da etapa T08. Configuração é resolvida por operação; resoluções simultâneas do mesmo tenant são compartilhadas e não criam uma fila ilimitada mesmo se o catálogo travar.

`snapshot()` expõe contadores de operações, filas, pools e resultados, sem dados/credenciais. O adaptador padrão emite falhas com tenant, nome da operação, código, resultado e duração. Sucessos não geram uma linha de log por transação. Nenhum SQL, parâmetros ou erro bruto do driver é registrado. O resolver customizado pode fornecer TLS com CA e validação de certificado; não há downgrade automático.

## Testes reproduzíveis

```powershell
npm test

# Apenas containers locais descartáveis, sem dados ou credenciais de produção.
docker run --name infotec-tenant-foundation-8 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -p 127.0.0.1:13318:3306 -d mysql:8.0
docker run --name infotec-tenant-foundation-55 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -p 127.0.0.1:13355:3306 -d mysql:5.5
# Aguardar ambos estarem prontos antes dos testes.
$env:RUN_TENANT_MYSQL_TESTS='true'
npm run test:tenant-database:mysql
Remove-Item Env:RUN_TENANT_MYSQL_TESTS
docker rm -f infotec-tenant-foundation-8 infotec-tenant-foundation-55
```

A suíte opt-in usa portas fixas locais, cria bancos únicos `tenant_foundation_*` e remove apenas os bancos que criou. Cobre Unicode/NULL/vazio/percent literal, BIGINT, isolamento por banco, rollback da segunda gravação, perda simulada de confirmação após COMMIT real, timeout, limites de concorrência e bloqueio de mudança de engine. A suíte sem banco cobre fila, aquisição tardia, destino inválido/alterado, expiração de pools, consultas não aguardadas, prazo de callback/commit e shutdown.

## Próxima integração

Implementar os schemas versionados e o repositório do domínio piloto, com IDs e recibos de idempotência. Acrescentar operação HTTP interna específica, autenticada e vinculada ao tenant autorizado; não expor o callback nem uma transação de SQL arbitrário. Depois conectar os consumidores, o migrador e o roteamento. Essas etapas, homologação de carga, dados do piloto e produção permanecem pendentes.

Referências: [transações InnoDB](https://dev.mysql.com/doc/refman/en/innodb-autocommit-commit-rollback.html) e [parâmetros preparados mysql2](https://sidorares.github.io/node-mysql2/docs/examples/queries/prepared-statements/select).
