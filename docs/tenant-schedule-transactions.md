# Transporte transacional da edição de agendas

`POST /api/instances/:instance/transactions` recebe comandos assinados do repositório do customers-service. Está limitado à operação `telephony.schedule.edit`, com duas escritas: UPDATE em campanhas_clientes e INSERT do recibo/auditoria em telephony_schedule_edits. Cada uma exige uma linha afetada. O tenant resolve a conexão pelo catálogo existente; host, banco e credenciais não vêm do pedido.

Configurar o mesmo `TENANT_TRANSACTION_SECRET`, aleatório com pelo menos 32 bytes, no customers-service e instances-service do ambiente. Não colocar essa chave no frontend. A assinatura HMAC SHA-256 vincula timestamp, nonce, caminho e JSON completo. Pedidos sem configuração/assinatura válida, fora de 60 segundos ou com nonce repetido não executam SQL. Não existe fallback para a rota SQL legada nem retry automático.

A camada transacional existente mantém uma conexão e exige InnoDB para todas as tabelas declaradas. A API confere triggers sob os locks de metadados e recusa escritas com triggers ainda não revisadas. As regras de edição, escopo, elegibilidade, CAS e recibo ficam no customers-service. O transporte aceita SQL produzido por esse serviço confiável; a assinatura é uma credencial de serviço e não deve ser entregue a usuários.

Erros retornam somente `code` e `outcome` (`NOT_COMMITTED` ou `UNKNOWN`), sem SQL, parâmetros ou dados de driver. `TENANT_TRANSACTION_AFFECTED_ROWS` aborta e faz rollback antes do próximo comando. Falha na confirmação do COMMIT permanece UNKNOWN. Cabe ao domínio reconciliar pelo recibo durável, nunca por mera igualdade dos campos.

Antes de disponibilizar: validar schema/triggers no tenant de destino, aplicar a migration revisada do customers-service e configurar as chaves por ambiente. Nenhum DDL ou alteração de produção ocorre no startup. Publicar instances-service compatível antes do customers-service e frontend. A validação local não comprova funcionamento do CRM real; tenants com triggers não revisadas permanecem bloqueados.

Testes: `npm test` inclui contrato HTTP/assinatura/CAS/outcome e a fundação transacional. A suíte MySQL da fundação e a de edição no customers-service são opt-in, com bancos sintéticos locais.
