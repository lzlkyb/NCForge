import type { Cell, ColumnMeta } from "./dbApi";
import type { TransferData, TransferOptions } from "./resultTransfer";

export const isTransferNumericType = (type: string): boolean => /^(NUMBER|FLOAT|INTEGER|INT|DECIMAL|NUMERIC|BINARY_DOUBLE|BINARY_FLOAT)/i.test(type);

const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const identifier = /^(?:[A-Za-z_][\w$#]*|"(?:[^"\r\n]|"")+")$/;
const qualifiedIdentifier = /^(?:[A-Za-z_][\w$#]*|"(?:[^"\r\n]|"")+")(?:\.(?:[A-Za-z_][\w$#]*|"(?:[^"\r\n]|"")+"))?$/;
const dateValue = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2})(\.\d{1,9})?)?(?:\s*(Z|[+-]\d{2}:\d{2}|[A-Za-z]+(?:\/[A-Za-z_]+)+))?$/;
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const normalizedIdentifier = (value: string) => value.startsWith('"') ? value.slice(1, -1).replace(/""/g, '"') : value.toUpperCase();

/** Numeric text is never parsed through Number, and TIMESTAMP fractions remain in the literal. */
export function transferSqlLiteral(value: Cell, type: string): string {
  if (value == null || value === "") return value === "" && !/^(DATE|TIMESTAMP)/i.test(type) && !isTransferNumericType(type) ? "''" : "NULL";
  const text = String(value);
  if (/^(DATE|TIMESTAMP)/i.test(type)) {
    const match = dateValue.exec(text);
    if (match) {
      const [, day, time, fraction, zone] = match;
      let date = `${day}${time ? ` ${time}` : ""}${fraction ?? ""}`;
      let mask = `YYYY-MM-DD${time ? " HH24:MI:SS" : ""}${fraction ? ".FF" : ""}`;
      if (zone) {
        date += ` ${zone === "Z" ? "+00:00" : zone}`;
        mask += zone === "Z" || /^[+-]/.test(zone) ? " TZH:TZM" : " TZR";
      }
      const functionName = zone ? "TO_TIMESTAMP_TZ" : /^TIMESTAMP/i.test(type) || fraction ? "TO_TIMESTAMP" : "TO_DATE";
      return `${functionName}(${quote(date)}, '${mask}')`;
    }
  }
  if (typeof value === "number" || isTransferNumericType(type) && numeric.test(text)) return text;
  if (typeof value === "boolean") return value ? "1" : "0";
  return quote(text);
}

function updateIndices(data: TransferData, options: TransferOptions, indices: number[], rowIndex: number): number[] {
  return indices.filter(i => !options.keys.includes(i) || data.rows[rowIndex][i] !== data.originalRows?.[rowIndex][i]);
}

function validTypedValue(value: Cell, type: string): boolean {
  return value == null || value === "" || ((!isTransferNumericType(type) || numeric.test(String(value))) && (!/^(DATE|TIMESTAMP)/i.test(type) || dateValue.test(String(value))));
}

/** Canonical decimal keys detect 1, 1.00 and 1e0 as the same key without losing precision. */
function keyIdentity(value: Cell, column: ColumnMeta): string {
  if (isTransferNumericType(column.type) && numeric.test(String(value))) {
    const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(String(value))!;
    const digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+/, "");
    if (!digits) return "0";
    const trimmed = digits.replace(/0+$/, "");
    const exponent = BigInt(match[4] ?? "0") - BigInt((match[3] ?? "").length) + BigInt(digits.length - trimmed.length);
    return `${match[1] === "-" ? "-" : ""}${trimmed}e${exponent}`;
  }
  return transferSqlLiteral(value, column.type);
}

export function validateTransferSql(data: TransferData, options: TransferOptions, indices: number[]): string | null {
  if (options.format !== "where") {
    if (!qualifiedIdentifier.test(options.table)) return "请填写有效目标表名，表达式或联表结果需确认表映射";
    if (options.schema && (!identifier.test(options.schema) || !identifier.test(options.table))) return "Schema 或表名无效，请不要重复填写 Schema";
  }
  const keys = options.keys;
  if (options.format === "update" && (!keys.length || !options.keysConfirmed)) return "UPDATE 必须选择并确认唯一键";
  if (options.format === "update" && (new Set(keys).size !== keys.length || keys.some(i => !Number.isInteger(i) || i < 0 || i >= data.columns.length))) return "UPDATE 键列索引无效或重复";
  const referenced = [...new Set([...indices, ...(options.format === "update" ? keys : [])])];
  if (referenced.some(i => !identifier.test(data.columns[i].name))) return "SQL 列名无效，请先确认目标列映射";
  if (new Set(referenced.map(i => normalizedIdentifier(data.columns[i].name))).size !== referenced.length) return "SQL 输出含重复目标列名，请先确认列映射";
  if (data.rows.some(row => indices.some(i => !validTypedValue(row[i], data.columns[i].type)))) return "数字或日期列存在无法生成可靠 SQL 字面量的值";
  if (options.format === "where" && (options.condition ?? "in") !== "where" && indices.length !== 1) return "IN / NOT IN 需要且只能选择一列";
  if (options.format !== "update") return null;
  if (!data.originalRows || data.originalRows.length !== data.rows.length) return "UPDATE 需要与当前记录逐行对应的查询原始值";
  if (!indices.some(i => !keys.includes(i)) && !data.rows.length) return "没有可更新的字段";
  const seen = new Set<string>();
  for (let rowIndex = 0; rowIndex < data.rows.length; rowIndex++) {
    const original = data.originalRows[rowIndex];
    if (keys.some(i => i >= original.length || original[i] == null || original[i] === "")) return "UPDATE 唯一键不能缺失或为 NULL / 空字符串";
    if (keys.some(i => !validTypedValue(original[i], data.columns[i].type))) return "UPDATE 原始键值无法生成可靠 SQL 字面量";
    if (keys.some(i => typeof original[i] === "number" && (!Number.isFinite(original[i]) || Number.isInteger(original[i]) && !Number.isSafeInteger(original[i])))) return "UPDATE 原始键值已超出安全精度，请重新读取为字符串";
    const identity = JSON.stringify(keys.map(i => keyIdentity(original[i], data.columns[i])));
    if (seen.has(identity)) return "UPDATE 原始键值重复，不能确认唯一记录";
    seen.add(identity);
    if (!updateIndices(data, options, indices, rowIndex).length) return "没有可更新的字段，请选择非键列或修改键值";
  }
  return null;
}

function rowCondition(row: Cell[], columns: ColumnMeta[], indices: number[]): string {
  return indices.map(i => {
    const literal = transferSqlLiteral(row[i], columns[i].type);
    return literal === "NULL" || literal === "''" ? `${columns[i].name} IS NULL` : `${columns[i].name} = ${literal}`;
  }).join(" AND ");
}

function inCondition(data: TransferData, options: TransferOptions, index: number): string {
  const column = data.columns[index];
  const values = [...new Set(data.rows.map(row => transferSqlLiteral(row[index], column.type)).filter(value => value !== "NULL" && value !== "''"))];
  const negative = options.condition === "notIn";
  const chunks: string[] = [];
  for (let start = 0; start < values.length; start += 1000) chunks.push(`${column.name} ${negative ? "NOT IN" : "IN"} (${values.slice(start, start + 1000).join(", ")})`);
  const hasNull = data.rows.some(row => row[index] == null || row[index] === "");
  const matchNull = options.includeNull && hasNull;
  if (!chunks.length) return matchNull ? `${column.name} IS ${negative ? "NOT " : ""}NULL` : negative ? "1 = 1" : "1 = 0";
  if (matchNull) chunks.push(`${column.name} IS ${negative ? "NOT " : ""}NULL`);
  const eol = options.lineEnding === "crlf" ? "\r\n" : "\n";
  return chunks.length === 1 ? chunks[0] : `(${chunks.join(`${eol}${negative ? "AND" : "OR"} `)})`;
}

export function serializeTransferSql(data: TransferData, options: TransferOptions, indices: number[]): string {
  const eol = options.lineEnding === "crlf" ? "\r\n" : "\n";
  if (options.format === "where") {
    if ((options.condition ?? "in") !== "where") return inCondition(data, options, indices[0]);
    const conditions = [...new Set(data.rows.map(row => `(${rowCondition(row, data.columns, indices)})`))];
    return `WHERE ${conditions.length ? conditions.join(`${eol}OR `) : "1 = 0"}`;
  }
  const table = options.schema ? `${options.schema}.${options.table}` : options.table;
  const statements = data.rows.map((row, rowIndex) => {
    if (options.format === "insert") return `INSERT INTO ${table} (${indices.map(i => data.columns[i].name).join(", ")}) VALUES (${indices.map(i => transferSqlLiteral(row[i], data.columns[i].type)).join(", ")});`;
    const changes = updateIndices(data, options, indices, rowIndex).map(i => `${data.columns[i].name} = ${transferSqlLiteral(row[i], data.columns[i].type)}`);
    return `UPDATE ${table} SET ${changes.join(", ")} WHERE ${rowCondition(data.originalRows![rowIndex], data.columns, options.keys)};`;
  });
  const lines: string[] = [];
  if (options.includeQuery && data.query) lines.push(...data.query.split(/\r\n|\r|\n/).map(line => `-- ${line}`));
  statements.forEach((statement, i) => {
    lines.push(statement);
    if (options.commitEvery > 0 && (i + 1) % options.commitEvery === 0) lines.push("COMMIT;");
  });
  if (options.commitEvery > 0 && statements.length % options.commitEvery !== 0) lines.push("COMMIT;");
  return lines.join(eol);
}
