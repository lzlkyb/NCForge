import { defaultTransferOptions, type TransferOptions, type TransferFormat } from "./resultTransfer";

export interface TransferPreset { name: string; options: Partial<TransferOptions> }
const KEY = "ncforge-db-output-presets";
export function lastTransferFormat(mode:"copy"|"file"): Pick<TransferOptions,"format"|"header"> {
  const base=defaultTransferOptions(mode==="copy" ? "tsv" : "xlsx");
  try {const value=sanitizeOptions(JSON.parse(localStorage.getItem(`${KEY}:last:${mode}`) ?? "{}"));return {format:mode==="copy" && value.format==="xlsx" ? "tsv" : value.format ?? base.format,header:value.header ?? base.header};}
  catch {return {format:base.format,header:base.header};}
}
export function rememberTransferFormat(mode:"copy"|"file",options:TransferOptions):void {
  try {localStorage.setItem(`${KEY}:last:${mode}`,JSON.stringify({format:options.format,header:options.header}));} catch { /* Storage may be unavailable; output itself remains usable. */ }
}
const fields = ["format", "header", "nullText", "delimiter", "lineEnding", "bom", "spreadsheetSafe", "transpose", "jsonStructure", "includeQuery", "condition", "includeNull"] as const;
export const builtinTransferPresets: TransferPreset[] = [
  { name: "贴到 Excel", options: { format: "tsv", header: "name", spreadsheetSafe: true } },
  { name: "接口 JSON", options: { format: "json", jsonStructure: "objects" } },
  { name: "文档表格", options: { format: "markdown", header: "both" } },
  { name: "主键查询", options: { format: "where", condition: "in" } },
  { name: "NC INSERT", options: { format: "insert", nc: true } },
];
export function readTransferPresets(): TransferPreset[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(stored)) return [];
    return stored.filter(p => p && typeof p.name === "string" && p.name.trim() && p.options && typeof p.options === "object").slice(0, 12)
      .map(p => ({ name: p.name.slice(0, 40), options: sanitizeOptions(p.options) }));
  } catch { return []; }
}
function sanitizeOptions(value: Partial<TransferOptions>): Partial<TransferOptions> {
  const result: Partial<TransferOptions> = {};
  const base = defaultTransferOptions();
  for (const field of fields) if (typeof value[field] === typeof base[field]) Object.assign(result, { [field]: value[field] });
  const formats: TransferFormat[] = ["tsv", "csv", "xlsx", "json", "jsonl", "html", "markdown", "insert", "where", "update"];
  if (result.format !== undefined && !formats.includes(result.format)) delete result.format;
  if (result.header !== undefined && !["name", "zh", "both", "none"].includes(result.header)) delete result.header;
  if (result.lineEnding !== undefined && !["lf", "crlf"].includes(result.lineEnding)) delete result.lineEnding;
  if (result.jsonStructure !== undefined && !["objects", "columns"].includes(result.jsonStructure)) delete result.jsonStructure;
  if (result.condition !== undefined && !["in", "notIn", "where"].includes(result.condition)) delete result.condition;
  return result;
}
export function saveTransferPreset(name: string, options: TransferOptions): TransferPreset[] {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) throw new Error("请输入预设名称");
  const next = [...readTransferPresets().filter(p => p.name !== trimmed), { name: trimmed, options: sanitizeOptions(options) }].slice(-12);
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
