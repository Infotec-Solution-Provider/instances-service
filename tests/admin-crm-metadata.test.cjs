const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { crmParameterSettings } = require("../dist/admin/crm-parameter-settings.metadata");
const { applyCrmDisplayMetadata } = require("../dist/admin/crm-settings");
const { snapshot } = require("../dist/admin/settings-utils");

const original = path.resolve(__dirname, "../../users-service/src/parameters/crm-parameter-settings.catalog.ts");
test("local typed business catalogue stays in parity with users-service without runtime cross-imports", { skip: !fs.existsSync(original) }, () => {
  const normalize = text => text.replace(/\r\n/g, "\n").trim();
  const copy = fs.readFileSync(path.join(__dirname, "../src/admin/crm-parameter-settings.metadata.ts"), "utf8").split(/\r?\n/).slice(1).join("\n");
  assert.equal(normalize(copy), normalize(fs.readFileSync(original, "utf8")));
});

test("all33 business labels and groups preserve schema types, codes, defaults and revisions", () => {
  process.env.ADMIN_REVISION_KEY = "fixture-revision-key-with-at-least-32-characters";
  assert.equal(crmParameterSettings.length, 33);
  assert.equal(new Set(crmParameterSettings.map(field => field.key)).size, 33);
  const fields = crmParameterSettings.map(known => ({ key: known.key, label: known.key, description: "Schema fallback", category: "CRM legado",
    type: known.type === "boolean" ? "enum" : "number", defaultValue: known.falseValue ?? "0", canReset: true, applyMode: "dynamic",
    ...(known.type === "boolean" ? { options: [{ label: known.trueValue, value: known.trueValue }, { label: known.falseValue, value: known.falseValue }, { label: "OUTRO", value: "OUTRO" }] } : {}),
  }));
  const displayed = fields.map(applyCrmDisplayMetadata);
  const wire = field => { const { label, description, category, options, ...rest } = field; return { ...rest, ...(options ? { options: options.map(option => option.value) } : {}) }; };
  for (let index = 0; index < displayed.length; index++) {
    const field = displayed[index], known = crmParameterSettings[index];
    assert.equal(field.label, known.label); assert.equal(field.description, known.description); assert.equal(field.category, known.group);
    assert.deepEqual(wire(field), wire(fields[index]));
    if (known.type === "boolean") assert.deepEqual(field.options.map(option => option.label), ["Ativado", "Desativado", "OUTRO"]);
  }
  const command = { action: "getSettings", environment: "homolog", tenant: "fixture", source: "crm" };
  const state = Object.fromEntries(fields.map(field => [field.key, field.defaultValue]));
  assert.equal(snapshot(command, state, fields).revision, snapshot(command, state, displayed).revision);
  assert.equal(displayed.find(field => field.key === "VALIDA_CPF_CNPJ").label, "Validar CPF e CNPJ");
  assert.equal(displayed.find(field => field.key === "AGENDA_FERIADO").category, "Agendamento");
  assert.equal(displayed.find(field => field.key === "LIMITE_AGENDAMENTO_DIA").type, "number");
});

test("unclassified schema columns retain the exact typed fallback metadata", () => {
  for (const field of [
    { key: "NEW_ENUM", label: "NEW_ENUM", description: "Schema", category: "CRM legado", type: "enum", options: [{ label: "S", value: "S" }, { label: "N", value: "N" }] },
    { key: "NEW_NUMBER", label: "NEW_NUMBER", description: "Schema", category: "CRM legado", type: "number", defaultValue: "7" },
  ]) assert.equal(applyCrmDisplayMetadata(field), field);
});
