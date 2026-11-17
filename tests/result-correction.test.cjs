const test = require("node:test");
const assert = require("node:assert/strict");
const {
	parseResultCorrection,
	correctScheduleResult,
} = require("../dist/tenant-database/result-correction");
const command = {
	operation: "crm.schedule.correct-result",
	scheduleId: 7,
	actorId: 3,
	oldResult: 1,
	newResult: 2,
	proposalCount: 1,
};
function fixture(opts = {}) {
	const writes = [];
	return {
		writes,
		tenant: opts.tenant || "acme",
		async execute(sql, params = []) {
			if (sql.includes("information_schema.TRIGGERS"))
				return opts.trigger ? [{}] : [];
			if (sql.includes("information_schema.REFERENTIAL_CONSTRAINTS"))
				return opts.cascade ? [{}] : [];
			if (sql.startsWith("SELECT ATIVO"))
				return [
					opts.actor || { ATIVO: "SIM", NIVEL: "ADMIN", SETOR: 2 },
				];
			if (sql.startsWith("SELECT cc.RESULTADO"))
				return [
					opts.row || { RESULTADO: 1, CONCLUIDO: "SIM", SETOR: 2 },
				];
			if (sql.startsWith("SELECT CODIGO FROM resultados"))
				return opts.noResult ? [] : [{ CODIGO: 2 }];
			if (sql.startsWith("SELECT CODIGO FROM propostas"))
				return Array.from({ length: opts.count ?? 1 }, () => ({
					CODIGO: 1,
				}));
			writes.push({ sql, params });
			return { affectedRows: 1 };
		},
	};
}
test("corrige a ficha, exclui propostas e registra resultado anterior e novo", async () => {
	const tx = fixture();
	const result = await correctScheduleResult(
		tx,
		parseResultCorrection(command),
	);
	assert.equal(result.removedProposals, 1);
	assert.equal(tx.writes.length, 3);
	assert.match(tx.writes[0].sql, /UPDATE campanhas_clientes/);
	assert.match(tx.writes[1].sql, /DELETE FROM propostas/);
	assert.match(tx.writes[2].sql, /INSERT INTO campanhas_clientes_log/);
	assert.deepEqual(tx.writes[2].params, [7, 3, "1", "2"]);
});
test("bloqueia ficha alterada, proposta alterada, operador e setor indevidos", async () => {
	for (const opts of [
		{ row: { RESULTADO: 4, CONCLUIDO: "SIM", SETOR: 2 } },
		{ row: { RESULTADO: 1, CONCLUIDO: "NAO", SETOR: 2 } },
		{ count: 2 },
		{ actor: { ATIVO: "SIM", NIVEL: "OPERADOR", SETOR: 2 } },
		{ tenant: "nunes", actor: { ATIVO: "SIM", NIVEL: "ADMIN", SETOR: 4 } },
		{ trigger: true },
		{ cascade: true },
		{ noResult: true },
	]) {
		const tx = fixture(opts);
		await assert.rejects(correctScheduleResult(tx, command));
		assert.equal(tx.writes.length, 0);
	}
});
test("valida os dados e aceita resultados antigos negativos", () => {
	assert.equal(
		parseResultCorrection({ ...command, oldResult: -10 }).oldResult,
		-10,
	);
	for (const c of [
		{ ...command, newResult: 0 },
		{ ...command, extra: 1 },
		{ ...command, oldResult: 2 },
	])
		assert.throws(() => parseResultCorrection(c));
});
