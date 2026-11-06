import type { BmfDetail, BmfEditOp, BmfEntity } from "./bmf";
import { BMF_BASE_TYPES, baseTypeById, baseTypeByName, fieldTypeOps } from "./bmfTypes";
import { parseCsv, type ParsedCsv } from "./csvParse";

export const META_COLUMNS = [["name", "字段名"], ["displayName", "显示名"], ["type", "类型"], ["field", "列名"], ["length", "长度"], ["precision", "精度"], ["nullable", "允许为空"], ["defaultValue", "默认值"]] as const;
export type MetaColumn = (typeof META_COLUMNS)[number][0] | "skip";
export interface MetaBulkPlan { ops: BmfEditOp[]; errors: string[]; count: number }
export interface MetaBatchChanges { nullable?: boolean; length?: number; precision?: number; defaultValue?: string; typeId?: string }
const IDENT = /^[a-z][a-z0-9_]*$/;

export function parseMetaPaste(text: string): ParsedCsv {
  if (text.length > 512 * 1024) throw new Error("粘贴内容超过 512 KiB，请分批处理");
  let quoted = false;
  for (let i = 0; i < text.length; i++) if (text[i] === '"') {
    if (quoted && text[i + 1] === '"') i++; else quoted = !quoted;
  }
  if (quoted) throw new Error("有未闭合的引号，请检查粘贴内容");
  const parsed = parseCsv(text);
  if (!parsed.headers.length || !parsed.rows.length) throw new Error("请粘贴含表头和数据行的 CSV / TSV");
  if (parsed.rows.length > 1000) throw new Error("一次最多粘贴 1000 行，请分批处理");
  return parsed;
}

export function autoMetaColumns(headers: string[]): MetaColumn[] {
  const aliases: Record<string, MetaColumn> = { name: "name", 字段: "name", 字段名: "name", displayname: "displayName", 显示名: "displayName", 中文名: "displayName",
    type: "type", typename: "type", datatype: "type", 类型: "type", field: "field", fieldname: "field", 列名: "field", length: "length", 长度: "length",
    precision: "precision", precise: "precision", 精度: "precision", nullable: "nullable", isnullable: "nullable", 允许为空: "nullable", defaultvalue: "defaultValue", 默认值: "defaultValue" };
  return headers.map((h) => aliases[h.toLowerCase().replace(/[ _-]/g, "")] ?? "skip");
}
function integer(value: string, min: number, label: string) {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > 0xffffffff) throw new Error(`${label}必须是 ${min === 0 ? "非负" : "正"}整数`);
  return number;
}
function nullable(value: string) {
  if (["true", "1", "是", "允许", "空"].includes(value.toLowerCase())) return true;
  if (["false", "0", "否", "非空", "不允许"].includes(value.toLowerCase())) return false;
  throw new Error("允许为空请使用 true / false 或 是 / 否");
}

/** 整批先预检，任何一行出错都不返回可执行操作；后端还会验证映射和写入语义。 */
export function planMetaPaste(detail: BmfDetail, entity: BmfEntity, parsed: ParsedCsv, columns: MetaColumn[], mode: "add" | "update"): MetaBulkPlan {
  const errors: string[] = [], adds: BmfEditOp[] = [], sets: BmfEditOp[] = [];
  const mapped = columns.filter((c) => c !== "skip");
  if (!mapped.includes("name")) errors.push("请映射字段名列");
  if (new Set(mapped).size !== mapped.length) errors.push("同一目标列只能映射一次");
  const seen = new Set<string>(), existing = new Map(entity.attrs.map((a) => [a.name.toLowerCase(), a]));
  parsed.rows.forEach((row, index) => {
    try {
      if (row.length !== columns.length) throw new Error("单元格数量与表头不一致");
      const data = Object.fromEntries(columns.map((key, i) => [key, row[i]]));
      const name = data.name?.trim() ?? "", key = name.toLowerCase();
      if (!name) throw new Error("字段名不能为空");
      if (seen.has(key)) throw new Error(`字段 ${name} 在本批重复`);
      seen.add(key);
      const attr = existing.get(key);
      if (mode === "add" && attr) throw new Error(`字段 ${name} 已存在，请选择更新模式`);
      if (mode === "update" && !attr) throw new Error(`字段 ${name} 不存在`);
      if (mode === "add" && !IDENT.test(name)) throw new Error("字段名须以小写字母开头，只含字母、数字、下划线");
      const typeValue = data.type?.trim();
      const type = typeValue ? baseTypeById(typeValue) ?? baseTypeByName(typeValue) : mode === "add" ? BMF_BASE_TYPES[0] : undefined;
      if (typeValue && !type) throw new Error(`无法确定类型 ${typeValue}，请使用基础类型名或 GUID`);
      const id = attr?.id ?? crypto.randomUUID();
      const allowNull = data.nullable?.trim() ? nullable(data.nullable.trim()) : attr?.nullable ?? true;
      if (attr?.isKey && allowNull) throw new Error("主键不能设置为允许为空");
      const length = data.length?.trim() ? integer(data.length.trim(), 1, "长度") : attr?.length ?? type?.length ?? null;
      const precision = data.precision?.trim() ? integer(data.precision.trim(), 0, "精度") : attr?.precision ?? type?.precision ?? null;
      if (length != null && precision != null && precision > length) throw new Error("精度不能大于长度");
      if (mode === "add") adds.push({ op: "addAttribute", id, entity: entity.id, name, displayName: data.displayName?.trim() || name,
        typeName: type!.name, dataType: type!.id, style: "SINGLE", dbType: type!.dbType, length, nullable: allowNull, defaultValue: data.defaultValue ?? "" });
      else if (type && attr) sets.push(...fieldTypeOps(detail, attr, type.id));
      const set = (name: string, value: string) => sets.push({ op: "setAttr", id, name, value });
      if (data.field != null) { const value = data.field.trim(); if (!IDENT.test(value)) throw new Error("列名须以小写字母开头，只含字母、数字、下划线"); if (value !== (attr?.field ?? name)) set("fieldName", value); }
      if (attr && data.displayName != null && data.displayName !== attr.displayName) set("displayName", data.displayName);
      if (attr && data.nullable?.trim() && allowNull !== attr.nullable) set("isNullable", String(allowNull));
      if (attr && data.length?.trim() && length !== attr.length) set("length", String(length));
      if (data.precision?.trim() && precision !== attr?.precision) set("precision", String(precision));
      if (attr && data.defaultValue != null && data.defaultValue !== attr.defaultValue) set("defaultValue", data.defaultValue);
    } catch (error) { errors.push(`第 ${index + 2} 行：${(error as Error).message}`); }
  });
  if (adds.length + sets.length > 10_000) errors.push("本批操作超过 10000，请减少行数或列数");
  return { ops: errors.length ? [] : [...adds, ...sets], errors, count: parsed.rows.length };
}

export function planMetaBatch(detail: BmfDetail, entity: BmfEntity, ids: string[], changes: MetaBatchChanges): MetaBulkPlan {
  const ops: BmfEditOp[] = [], errors: string[] = [];
  for (const id of new Set(ids)) {
    const field = entity.attrs.find((a) => a.id === id);
    if (!field) { errors.push("选中的字段已删除，请重新选择"); continue; }
    try {
      if (changes.typeId) ops.push(...fieldTypeOps(detail, field, changes.typeId));
      if (changes.nullable && field.isKey) throw new Error("主键不能设置为允许为空");
      const set = (name: string, value: string) => ops.push({ op: "setAttr", id, name, value });
      if (changes.nullable != null && changes.nullable !== field.nullable) set("isNullable", String(changes.nullable));
      if (changes.length != null) set("length", String(integer(String(changes.length), 1, "长度")));
      if (changes.precision != null) set("precision", String(integer(String(changes.precision), 0, "精度")));
      if ((changes.precision ?? field.precision ?? 0) > (changes.length ?? field.length ?? Infinity)) throw new Error("精度不能大于长度");
      if (changes.defaultValue != null && changes.defaultValue !== field.defaultValue) set("defaultValue", changes.defaultValue);
    } catch (error) { errors.push(`${field.name}：${(error as Error).message}`); }
  }
  return { ops: errors.length ? [] : ops, errors, count: new Set(ids).size };
}

export const META_TEMPLATES: Record<string, string> = {
  "删除标记与时间戳": "字段名\t显示名\t类型\t长度\t允许为空\t默认值\ndr\t删除标记\tInteger\t\tfalse\t0\nts\t时间戳\tUFDateTime\t19\tfalse\t",
  "审计字段": "字段名\t显示名\t类型\t长度\t允许为空\ncreator\t创建人\tUFID\t20\ttrue\ncreationtime\t创建时间\tUFDateTime\t19\ttrue\nmodifier\t最后修改人\tUFID\t20\ttrue\nmodifiedtime\t最后修改时间\tUFDateTime\t19\ttrue",
  "自定义字段": "字段名\t显示名\t类型\t长度\t允许为空\n" + Array.from({ length: 5 }, (_, i) => `def${i + 1}\t自定义项${i + 1}\tBS000010000100001056\t101\ttrue`).join("\n"),
};
