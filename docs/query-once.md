# Consulta de tenant sem repetição

`POST /api/instances/:clientName/query-once` usa o contrato interno `{query,parameters}` do executor existente, mas desativa qualquer repetição após perda de conexão. A rota distinta permite aos consumidores detectar versões antigas por 404 antes de enviar uma gravação à rota legada com replay.

Retorno 200: `{message,result}`; preserva `insertId` e `affectedRows` do comando, sem uma chamada separada a LAST_INSERT_ID. Erro de chave duplicada: 409, `code=TENANT_DUPLICATE_KEY`. Outros erros: 503, `code=TENANT_QUERY_FAILED`. Em ambos, `outcome=UNKNOWN` é conservador: um executor SQL genérico não pode garantir rollback ou ausência de efeitos parciais apenas pelo erro. Não retorna mensagem do driver, SQL ou parâmetros.

A infraestrutura tem a mesma fronteira interna do executor legado: não autentica usuários finais. Não publicar pelo proxy do navegador; os serviços de domínio autenticam sessão e autorização antes da chamada. Esta rota não cria autorização para SQL fornecido pelo usuário nem disponibiliza transação entre requisições. A rota `/query` anterior conserva seu comportamento.

O primeiro consumidor é a administração de segmentos do customers-service. Habilitar a capacidade aqui antes de publicar o consumidor. Testes HTTP e de pool verificam preservação do resultado, sanitização e uma única tentativa em erro de protocolo. Nenhuma alteração de configuração de tenant/pool ou publicação acompanha o código.
