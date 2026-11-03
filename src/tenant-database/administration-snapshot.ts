// Protocol crm-administration-v1. Keep identical to instances-service/tenant-database/administration-snapshot.ts.
import { createHash } from "node:crypto";
export type Row = Record<string, string | number | null>;
export type Read = <T>(sql: string, params: unknown[]) => Promise<T>;
export const transferTables = [
  "clientes",
  "operadores",
  "campanhas_clientes",
  "fidelizacoes",
  "transferencia_clientes",
  "transferencia_clientes_itens",
  "crm_administration_transfers",
];
export class AdministrationFault extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
export async function checkTransferSchema(read: Read): Promise<void> {
  await checkSchema(read, {
    transferencia_clientes: [
      "CODIGO",
      "DATA_HORA",
      "OPERADOR",
      "OPERADOR_ORIGEM",
      "OPERADOR_DESTINO",
    ],
    transferencia_clientes_itens: ["CODIGO", "CLIENTE"],
    crm_administration_transfers: [
      "operation_id",
      "request_hash",
      "actor_id",
      "transfer_id",
      "before_json",
      "after_json",
      "created_at",
    ],
  });
  const keys = await read<
    { column_name: string; sequence: number; prefix_length: number | null }[]
  >(
    "SELECT COLUMN_NAME AS column_name,SEQ_IN_INDEX AS sequence,SUB_PART AS prefix_length FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='crm_administration_transfers' AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX LIMIT 3",
    [],
  );
  if (
    keys.length !== 1 ||
    keys[0]!.column_name !== "operation_id" ||
    Number(keys[0]!.sequence) !== 1 ||
    keys[0]!.prefix_length !== null
  )
    throw new AdministrationFault("SCHEMA_UNSUPPORTED");
}
export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const required: Record<string, string[]> = {
  clientes: ["CODIGO", "RAZAO", "OPERADOR", "COD_CAMPANHA"],
  operadores: ["CODIGO", "NOME", "ATIVO"],
  campanhas_clientes: [
    "CODIGO",
    "CLIENTE",
    "CAMPANHA",
    "OPERADOR",
    "CONCLUIDO",
    "FIDELIZA",
    "DT_AGENDAMENTO",
    "DATA_HORA_LIG",
    "DATA_HORA_FIM",
  ],
  fidelizacoes: [
    "CODIGO",
    "CLIENTE",
    "OPERADOR_CRIACAO",
    "CC_CODIGO",
    "QTDE_FIDELIZAR",
  ],
};
export async function checkSchema(
  read: Read,
  requirements = required,
): Promise<void> {
  const names = Object.keys(requirements);
  const columns = await read<
    { table_name: string; column_name: string; data_type: string }[]
  >(
    `SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name,DATA_TYPE AS data_type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${names.map(() => "?").join(",")}) LIMIT 2001`,
    names,
  );
  if (
    !Array.isArray(columns) ||
    columns.length > 2000 ||
    names.some((table) =>
      requirements[table]!.some(
        (column) =>
          !columns.some(
            (c) =>
              c.table_name.toLowerCase() === table &&
              c.column_name.toUpperCase() === column.toUpperCase(),
          ),
      ),
    )
  )
    throw new AdministrationFault("SCHEMA_UNSUPPORTED");
  const numeric = new Set([
    "CODIGO",
    "CLIENTE",
    "OPERADOR",
    "COD_CAMPANHA",
    "OPERADOR_CRIACAO",
    "CC_CODIGO",
    "QTDE_FIDELIZAR",
    "SETOR",
    "CODIGO_CAMPANHA_CLIENTE",
  ]);
  if (
    columns.some(
      (c) =>
        requirements[c.table_name.toLowerCase()]?.includes(
          c.column_name.toUpperCase(),
        ) &&
        numeric.has(c.column_name.toUpperCase()) &&
        !["int", "smallint", "bigint", "mediumint", "tinyint"].includes(
          c.data_type,
        ),
    )
  )
    throw new AdministrationFault("SCHEMA_UNSUPPORTED");
}
export interface Snapshot {
  customers: Row[];
  schedules: Row[];
  loyalties: Row[];
  operators: Row[];
}
export async function readSnapshot(
  read: Read,
  tenant: string,
  customerIds: number[],
  source: number,
  destination: number,
  lock = false,
): Promise<Snapshot> {
  const requirements = Object.fromEntries(
    Object.entries(required).map(([table, fields]) => [table, [...fields]]),
  );
  if (tenant === "nunes") {
    requirements["clientes"]!.push("SETOR");
    requirements["operadores"]!.push("SETOR");
  }
  await checkSchema(read, requirements);
  const suffix = lock ? " FOR UPDATE" : "",
    slots = customerIds.map(() => "?").join(",");
  const select = async (table: string, where: string, params: unknown[]) => {
    const fields = requirements[table]!;
    const rows = await read<Row[]>(
      `SELECT ${fields.map((field) => `CAST(\`${field}\` AS CHAR) AS \`${field}\``).join(",")} FROM \`${table}\` WHERE ${where} ORDER BY CODIGO LIMIT 501${suffix}`,
      params,
    );
    if (!Array.isArray(rows) || rows.length > 500)
      throw new AdministrationFault("SELECTION_TOO_LARGE");
    if (
      rows.some((row) => !/^[1-9]\d*$/.test(String(row["CODIGO"]))) ||
      new Set(rows.map((row) => String(row["CODIGO"]))).size !== rows.length
    )
      throw new AdministrationFault("SCHEMA_UNSUPPORTED");
    // Deterministic property order, driver-independent scalar types and dates (including historical zero dates).
    return rows.map(
      (row) =>
        Object.fromEntries(
          fields.map((field) => [
            field,
            row[field] == null ? null : String(row[field]),
          ]),
        ) as Row,
    );
  };
  const customers = await select(
    "clientes",
    `CODIGO IN (${slots})`,
    customerIds,
  );
  if (
    customers.length !== customerIds.length ||
    customers.some((row) => !customerIds.includes(Number(row["CODIGO"])))
  )
    throw new AdministrationFault("SELECTION_CHANGED");
  const schedules = await select(
    "campanhas_clientes",
    `CLIENTE IN (${slots}) AND CONCLUIDO='NAO'`,
    customerIds,
  );
  const loyalties = await select(
    "fidelizacoes",
    `CLIENTE IN (${slots})`,
    customerIds,
  );
  const operators = await select(
    "operadores",
    "CODIGO IN (?,?)",
    [source, destination].sort((a, b) => a - b),
  );
  return { customers, schedules, loyalties, operators };
}
const civil = (value: string | number | null | undefined) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) &&
  value >= "1000-01-01 00:00:00"
    ? value
    : null;
export function transferEffects(
  snapshot: Snapshot,
  tenant: string,
  source: number,
  destination: number,
) {
  const reasons: string[] = [];
  const target = snapshot.operators.find(
    (row) => Number(row["CODIGO"]) === destination,
  );
  if (
    !target ||
    target["ATIVO"] !== "SIM" ||
    !snapshot.operators.some((row) => Number(row["CODIGO"]) === source)
  )
    reasons.push("OPERATORS_UNAVAILABLE");
  if (
    snapshot.schedules.some((row) => {
      const start = civil(row["DATA_HORA_LIG"]),
        end = civil(row["DATA_HORA_FIM"]);
      return start && (!end || start > end);
    })
  )
    reasons.push("ACTIVE_ATTENDANCE");
  if (
    tenant === "nunes" &&
    snapshot.customers.some(
      (row) =>
        !target || row["SETOR"] == null || row["SETOR"] !== target["SETOR"],
    )
  )
    reasons.push("SECTOR_MISMATCH");
  const customers = snapshot.customers.filter(
    (row) => Number(row["OPERADOR"]) === source,
  );
  const schedules = snapshot.schedules.filter(
    (row) => Number(row["OPERADOR"]) === source,
  );
  const loyalties = snapshot.loyalties.filter(
    (row) => Number(row["OPERADOR_CRIACAO"]) === source,
  );
  if (
    snapshot.customers.some(
      (row) =>
        !customers.includes(row) &&
        !schedules.some((s) => s["CLIENTE"] === row["CODIGO"]) &&
        !loyalties.some((s) => s["CLIENTE"] === row["CODIGO"]),
    )
  )
    reasons.push("SELECTION_CHANGED");
  return { customers, schedules, loyalties, reasons };
}
export function snapshotVersion(
  tenant: string,
  ids: number[],
  source: number,
  destination: number,
  snapshot: Snapshot,
) {
  return hash([
    "crm-administration-v1",
    tenant,
    ids,
    source,
    destination,
    snapshot,
  ]);
}
