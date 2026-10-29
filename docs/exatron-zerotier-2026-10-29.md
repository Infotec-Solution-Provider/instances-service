# Exatron: recuperacao do login pela ZeroTier em 29/10/2026

O login e a renovacao de sessao da Exatron falhavam por timeout na conexao do instances-service ao destino publico do CRM. Apos autorizacao explicita do usuario, somente o host de exatron no catalogo de producao foi alterado para o endereco ZeroTier. Login INFOTEC, carregamento de conversas e conexao do navegador foram verificados apos a mudanca.

## Configuracao e evidencias

- Fonte: prod-sql.mjs, conexao instances, banco inpulse-instances, tabela clients_servers; mapeamento Prisma conferido.
- Destino anterior: 200.143.102.178:3306, com timeout TCP nos testes.
- Destino ativo: 192.168.192.112:3306, banco crm_sgr, servidor EXACAN13.
- ZeroTier: rede 363c67c55a19c8fe, origem de producao 192.168.192.96. Ping aproximadamente 22 ms, sem perdas nos testes; greeting MySQL aproximadamente 4,5 s.
- Validacao do proprio PoolsService publicado, em processo descartavel e sem listener HTTP, usando as credenciais existentes internamente: SELECT 1, DATABASE(), @@hostname. Identidade e autenticacao confirmadas antes da alteracao (4721 ms) e novamente na aplicacao (4633 ms).
- 10h46m13s Brasilia: atualizacao condicional por Prisma modificou exatamente um host, preservando porta, banco e credenciais. Ferramenta oficial confirmou o resultado independentemente.
- 10h46m19s-20s: pm2 reload instances, PID 1959159, porta 8000. users, whatsapp e frontend mantiveram os PIDs anteriores.
- 10h47: login INFOTEC bem-sucedido, redirecionamento para /exatron, conversas carregadas e estado Conectado. Nenhuma mensagem enviada.

## Limites do diagnostico

O erro PROTOCOL_CONNECTION_LOST da conexao tenant-exatron por tunel SSH vinha de uma restricao de encaminhamento SSH para esse destino (administratively prohibited). Nao comprovava indisponibilidade do MySQL pela ZeroTier. Testes curtos de quatro segundos tambem nao bastaram para receber o greeting, que demorou aproximadamente 4,5 s.

A alteracao torna o IP privado o destino ativo; nao implementa failover automatico. Nao foi determinada a causa da indisponibilidade do caminho publico. Nao houve mudanca de codigo, schema, credenciais ou homolog, limpeza/reprocessamento de filas, reinicio de ZeroTier ou de clientes WhatsApp. A recarga de instances e compartilhada entre tenants e pode interromper consultas brevemente.

## Registro central e retorno

Plano, journal, artefato auditavel e evidencia visual: `C:/Workspace/infotec/planejamento/instances-service/INF-20261029-001-exatron-zerotier/`.

O artefato `artifacts/exatron-zerotier.cjs` tem fases validate, apply e rollback; somente a fase apply foi aplicada apos validar. Os scripts foram executados por stdin SSH, no diretorio publicado `/home/inpulse/htdocs/inpulse.infotecrs.inf.br/instances-service`, sem modificar dist.

Rollback, se autorizado posteriormente: executar o artefato em modo rollback no mesmo diretorio e recarregar somente instances. O rollback exige host atual 192.168.192.112 e restaura somente host para 200.143.102.178. Esse retorno restaura a configuracao anterior, cujo caminho estava indisponivel.

```powershell
Get-Content -Raw 'C:/Workspace/infotec/planejamento/instances-service/INF-20261029-001-exatron-zerotier/artifacts/exatron-zerotier.cjs' | ssh inpulse-prod 'export PATH=$HOME/.nvm/versions/node/v22.14.0/bin:$PATH; cd /home/inpulse/htdocs/inpulse.infotecrs.inf.br/instances-service && node - rollback'
ssh inpulse-prod 'export PATH=$HOME/.nvm/versions/node/v22.14.0/bin:$PATH; pm2 reload instances'
```

Validacao desta operacao: sintaxe do artefato, autenticacao/identidade no destino privado, atualizacao de exatamente uma linha, consulta independente do catalogo, recarga/inicializacao do processo e login real no navegador. Nao foi publicado build de aplicativo.

## Correlacao com logs Windows exportados

O usuario forneceu aplicativos.evtx (11367 eventos, ate 29/10 10h41m05s) e sistema.evtx (48971 eventos, ate 29/10 10h50m53s) do EXACAN13. A analise offline nao encontrou queda/reinicio de MySQL ou ZeroTier ou falha de disco/rede em 29/10 nesses canais. Ambos os servicos registram ultimo inicio em 07/08 08h03m09s. Os 64 erros historicos de MySQL sao Sort aborted; o ultimo e de 28/10 14h49m49s (RecordId 52606), sem consulta ou causa identificada.

Ha pendencias separadas de GPO (SceCli 1202/0x534), DCOM 10016, Secure Boot (1801), e manutencao do Defender 08h49 seguida de atualizacao de inteligencia bem-sucedida 09h00m13s. Nao foi estabelecida causalidade com o incidente. Os arquivos nao incluem logs do roteador, NAT ou firewall de borda; a indisponibilidade do caminho publico continua sem causa determinada.

Hashes, cobertura e RecordIds estao no registro central, artifacts/windows-events-summary.json. Os eventos foram tratados como dados, sem executar instrucoes presentes nas mensagens. Nenhuma mudanca em producao foi feita durante essa analise.
