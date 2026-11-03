import type { TenantTransaction } from "../tenant-database/transaction";
import { TenantDatabaseError } from "../tenant-database/error";

const slots = [["AREA1", "FONE1"], ["AREA2", "FONE2"], ["AREA3", "FONE3"], ["AREAFAX", "FAX"]] as const;
interface Column { TABLE_NAME: string; COLUMN_NAME: string; DATA_TYPE: string; IS_NULLABLE: string; COLUMN_DEFAULT: unknown; EXTRA: string; COLUMN_KEY: string; CHARACTER_MAXIMUM_LENGTH: number | null }
const unsupported = (): never => { throw new TenantDatabaseError("TENANT_CUSTOMER_PHONE_SCHEMA_UNSUPPORTED"); };

/** Fixed repository command: no caller SQL/phone list, no modification of call history. */
export async function synchronizeCustomerPhones(tx: TenantTransaction, customerId: number): Promise<void> {
  if (!Number.isSafeInteger(customerId) || customerId < 1) return unsupported();
  const columns = await tx.execute<Column[]>("SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,COLUMN_KEY,CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('clientes','fones_campanha_cli') ORDER BY TABLE_NAME,ORDINAL_POSITION LIMIT 401");
  if (!Array.isArray(columns) || columns.length >= 401) return unsupported();
  const link = columns.filter(column => column.TABLE_NAME === "fones_campanha_cli");
  const id = link.find(column => column.COLUMN_NAME === "CODIGO"), owner = link.find(column => column.COLUMN_NAME === "CLIENTE"), phoneColumn = link.find(column => column.COLUMN_NAME === "FONE");
  if (!id || id.DATA_TYPE !== "int" || id.COLUMN_KEY !== "PRI" || !id.EXTRA.includes("auto_increment") || owner?.DATA_TYPE !== "int" || !phoneColumn || !["varchar", "char"].includes(phoneColumn.DATA_TYPE) || Number(phoneColumn.CHARACTER_MAXIMUM_LENGTH) < 11) return unsupported();
  if (link.some(column => !["CODIGO", "CLIENTE", "FONE"].includes(column.COLUMN_NAME) && column.IS_NULLABLE !== "YES" && column.COLUMN_DEFAULT === null && !column.EXTRA.includes("GENERATED"))) return unsupported();
  // Refuse schemas where removing an obsolete current number could cascade into history.
  const references = await tx.execute<unknown[]>("SELECT TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='fones_campanha_cli' LIMIT 1");
  if (references.length) return unsupported();
  const indexes = await tx.execute<{ INDEX_NAME: string; COLUMN_NAME: string }[]>("SELECT INDEX_NAME,COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fones_campanha_cli' AND NON_UNIQUE=0 ORDER BY INDEX_NAME,SEQ_IN_INDEX LIMIT 101");
  const unique = new Map<string, string[]>();
  for (const index of indexes) unique.set(index.INDEX_NAME, [...(unique.get(index.INDEX_NAME) ?? []), index.COLUMN_NAME]);
  if (indexes.length >= 101 || ![...unique.values()].some(keys => keys.length === 2 && keys.includes("CLIENTE") && keys.includes("FONE"))) return unsupported();
  const names = new Set(columns.filter(column => column.TABLE_NAME === "clientes").map(column => column.COLUMN_NAME));
  const supported = slots.filter(([area, phone]) => names.has(area) && names.has(phone));
  if (!supported.length || slots.some(([area, phone]) => names.has(area) !== names.has(phone))) return unsupported();
  const rows = await tx.execute<Record<string, unknown>[]>(`SELECT ${supported.flat().map(key => `\`${key}\``).join(",")} FROM clientes WHERE CODIGO=? FOR UPDATE`, [customerId]);
  if (rows.length !== 1) return unsupported();
  const phones: string[] = [];
  let emptySeen = false;
  for (const [areaKey, phoneKey] of supported) {
    const area = String(rows[0]![areaKey] ?? ""), number = String(rows[0]![phoneKey] ?? "");
    if ((!area || area === "0") && !number) { emptySeen = true; continue; }
    if (emptySeen || !/^[1-9]\d$/.test(area) || !/^\d{8,9}$/.test(number)) throw new TenantDatabaseError("TENANT_CUSTOMER_PHONE_INVALID");
    if (!phones.includes(area + number)) phones.push(area + number);
  }
  if (!phones.length) throw new TenantDatabaseError("TENANT_CUSTOMER_PHONE_INVALID");
  // Retain the identity and classification of unchanged phone rows. Duplicate customer slots form one set.
  await tx.execute(`DELETE FROM fones_campanha_cli WHERE CLIENTE=? AND (FONE IS NULL OR FONE NOT IN (${phones.map(() => "?").join(",")}))`, [customerId, ...phones]);
  for (const phone of phones) {
    const result = await tx.execute<{ affectedRows: number }>("INSERT INTO fones_campanha_cli (CLIENTE,FONE) SELECT ?,? FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM fones_campanha_cli WHERE CLIENTE=? AND FONE=?)", [customerId, phone, customerId, phone]);
    if (![0, 1].includes(result.affectedRows)) throw new TenantDatabaseError("TENANT_TRANSACTION_AFFECTED_ROWS");
  }
}
