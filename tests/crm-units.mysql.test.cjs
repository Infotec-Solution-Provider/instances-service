const { test } = require("node:test");
const assert = require("node:assert/strict");
const mysql = require("mysql2/promise");
const { TenantDatabase } = require("../dist/tenant-database/tenant-database");
const { tenantDatabaseConfig } = require("../dist/tenant-database/config");
const { CrmUnitsService } = require("../dist/crm-units/service");

// Opt-in only: local disposable schemas, never a tenant registry or environment credentials.
for (const port of require("./isolated-mysql-ports.cjs")("CRM_UNITS_MYSQL_PORTS", [13328, 13329])) {
  test(`CRM units on isolated MySQL ${port}`, { skip: process.env.RUN_CRM_UNITS_MYSQL !== "true" }, async () => {
    const admin = await mysql.createConnection({ host: "127.0.0.1", port, user: "root" });
    const prefix = `crm_units_${process.pid}_${Date.now()}`;
    const names = { alpha: prefix + "_a", beta: prefix + "_b" }, created = [];
    const database = new TenantDatabase(async tenant => names[tenant] ? {
      tenant, host: "127.0.0.1", port, user: "root", password: "", database: names[tenant],
    } : null, { ...tenantDatabaseConfig({}), transactionMs: 10000 });
    const service = new CrmUnitsService(database);
    const run = (tenant, command, body = {}) => service.execute(tenant, { action: "units", command, ...body });
    const fields = { CODIGO: 2, DESCRICAO: "São José", INATIVOS_RECENTES: 30, INATIVOS_ANTIGOS: 90 };
    const campaign = { CODIGO: 11, NOME: "Novos clientes", TIPO: "PROSPE", MAX_RESPOSTA: 300, PAUSADA: "SIM" };
    try {
      for (const name of Object.values(names)) {
        assert.match(name, /^crm_units_\d+_\d+_[ab]$/);
        await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET latin1 COLLATE latin1_swedish_ci`);
        created.push(name);
        await admin.query(`USE \`${name}\``);
        await admin.query("CREATE TABLE parametros(CODIGO INT PRIMARY KEY) ENGINE=InnoDB");
        await admin.query("INSERT INTO parametros VALUES(1)");
        await admin.query("CREATE TABLE unidades(CODIGO INT PRIMARY KEY,DESCRICAO VARCHAR(50),INATIVOS_RECENTES INT,INATIVOS_ANTIGOS INT) ENGINE=InnoDB");
        await admin.query("INSERT INTO unidades VALUES(1,'Legada',90,180)");
        await admin.query("CREATE TABLE campanhas(CODIGO INT PRIMARY KEY,NOME VARCHAR(150) UNIQUE,DATA_INI DATETIME NULL,MAX_RESPOSTA INT,DESCRICAO TEXT,PRIORIDADE INT,SQL_CAMPANHA TEXT,GERADO_LISTA ENUM('SIM','NAO'),PAUSADA ENUM('SIM','NAO'),PAUSAR_AG_PUBLICA ENUM('SIM','NAO'),TIPO ENUM('ATIVOS','INAT_R','INAT_A','PROSPE'),UNIDADE INT,OPERADOR INT) ENGINE=InnoDB");
      }
      await run("alpha", "create", { fields, campaigns: [campaign] });
      const detail = await run("alpha", "detail", { id: 2 });
      assert.equal(detail.campaigns.length, 1);
      assert.equal(detail.campaigns[0].PAUSADA, "SIM");
      assert.equal((await run("beta", "list")).data.length, 1);
      const { CODIGO, ...expected } = detail.campaigns[0];
      await assert.rejects(run("alpha", "campaign-patch", { id: CODIGO, changes: { PAUSADA: "NAO" }, expected }), { code: "TENANT_ORDERING_COMPOSITION_PENDING" });
      await run("alpha", "campaign-patch", { id: CODIGO, changes: { NOME: "Público com nome próprio" }, expected });
      await assert.rejects(run("alpha", "campaign-patch", { id: CODIGO, changes: { NOME: "Snapshot antigo" }, expected }), { code: "TENANT_ORDERING_CHANGED" });
      const concurrent = await Promise.allSettled([12, 13].map(id => run("alpha", "campaign-create", { fields: { ...campaign, CODIGO: id, NOME: `Ativos ${id}`, TIPO: "ATIVOS", UNIDADE: 2 } })));
      assert.equal(concurrent.filter(r => r.status === "fulfilled").length, 1);
      assert.equal((await run("alpha", "detail", { id: 2 })).campaigns.length, 2);
      // A real DB constraint fails the second campaign after the unit and first INSERT.
      await assert.rejects(run("alpha", "create", { fields: { ...fields, CODIGO: 3, DESCRICAO: "Rollback" }, campaigns: [
        { ...campaign, CODIGO: 20, NOME: "Duplicado", TIPO: "ATIVOS" },
        { ...campaign, CODIGO: 21, NOME: "Duplicado", TIPO: "PROSPE" },
      ] }));
      assert.equal((await run("alpha", "list")).data.some(u => u.CODIGO === 3), false);
      await admin.query(`USE \`${names.alpha}\``);
      const [rows] = await admin.query("SELECT CODIGO FROM campanhas WHERE CODIGO IN (20,21)");
      assert.equal(rows.length, 0);
      await run("alpha", "patch", { id: 2, changes: { DESCRICAO: "Unidade renomeada" }, expected: fields });
      assert.equal((await run("alpha", "detail", { id: 2 })).campaigns.length, 2);
    } finally {
      await database.close();
      for (const name of created) await admin.query(`DROP DATABASE \`${name}\``);
      await admin.end();
    }
  });
}
