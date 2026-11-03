# Cobertura DDD/cidade (G04)

`20261103-ddd-coverage.sql` cria uma tabela própria de cobertura. Não altera
`cidades_ddd`, que permanece como exceções de discagem local. O provisionamento
não roda na inicialização da aplicação e não foi executado em bancos compartilhados.

A API descobre a tabela em runtime e mantém a gravação indisponível até existir
estrutura compatível. Gravações requerem InnoDB também em `fone_areas` e `cidades`;
essa frente não converte engines existentes. Não há FK contra campos legados de
tipo/collation desconhecidos: comandos assinados verificam e bloqueiam o DDD e
as cidades; o cadastro de cidades protege `crm_ddd_city_links.city_id` contra
exclusão e renomeação. Instale as versões de customers e instances em conjunto.

As associações são aditivas e idempotentes pela PK `(ddd, city_id)`. A origem é a
consulta BrasilAPI feita novamente antes da gravação. Nome externo, UF, responsável
e data ficam registrados. Não há substituição, exclusão ou efeito na discagem.

Para validar a migração em um MySQL local descartável sem senha, ouvindo somente
em loopback na porta 13328, rode no PowerShell:

```powershell
npm run build
$env:RUN_DDD_COVERAGE_MYSQL = 'true'
node --test tests/ddd-coverage.mysql.test.cjs
Remove-Item Env:RUN_DDD_COVERAGE_MYSQL
```

O teste cria e remove exclusivamente um banco novo `ddd_coverage_<pid>_<timestamp>`.
A porta pode ser ajustada com `DDD_COVERAGE_MYSQL_PORT`; o host permanece fixo em
127.0.0.1. Sem a variável opt-in, o teste é ignorado e não abre conexão.

Antes de provisionar em qualquer ambiente existente, valide o SQL no banco isolado
e confirme tipos/engine/capacidades do tenant. A aplicação não corrige schema nem
reinterpreta exceções automaticamente. O rollback de aplicação pode deixar a nova
tabela intacta para preservar dados; não há script de remoção automática.
