// LSP ↔ Monaco 的纯数据转换。不引 monaco（可直接单测），成员名对应的 Monaco 枚举由 langProviders 再查表。

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface MonacoRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** LSP 的行列从 0 开始，Monaco 从 1 开始（两边列都按 UTF-16 计，无需换算）。 */
export function toMonacoRange(r: LspRange): MonacoRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

export function toLspPosition(line: number, column: number): LspPosition {
  return { line: line - 1, character: column - 1 };
}

/**
 * `file:///C:/a/b%20c.java` → `C:\a\b c.java`。不是 file 协议（如 `jdt://`）返回 null。
 *
 * Monaco 的 `Uri.toString()` 会把盘符的冒号编成 `%3A`，也要能解出来。
 */
export function uriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  let p: string;
  try {
    p = decodeURIComponent(uri.slice("file://".length));
  } catch {
    return null;
  }
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return /^[A-Za-z]:/.test(p) ? p.replace(/\//g, "\\") : p;
}

/** `jdt://contents/xxx.jar/nc.bs.dao/BaseDAO.class?=...` → `BaseDAO.java`。 */
export function jdtDisplayName(uri: string): string {
  const path = uri.split("?")[0];
  const last = path.slice(path.lastIndexOf("/") + 1);
  return last.replace(/\.class$/i, ".java");
}

/** jdt.ls 找不到 `_src.jar` 时给的是反编译桩（只有方法签名），正文里带这句话。 */
export function isStubSource(text: string): boolean {
  return text.includes("Failed to get sources");
}

/** LSP CompletionItemKind（1~25）→ Monaco `CompletionItemKind` 的成员名。 */
const COMPLETION_KINDS = [
  "Text",
  "Method",
  "Function",
  "Constructor",
  "Field",
  "Variable",
  "Class",
  "Interface",
  "Module",
  "Property",
  "Unit",
  "Value",
  "Enum",
  "Keyword",
  "Snippet",
  "Color",
  "File",
  "Reference",
  "Folder",
  "EnumMember",
  "Constant",
  "Struct",
  "Event",
  "Operator",
  "TypeParameter",
] as const;

export type CompletionKindName = (typeof COMPLETION_KINDS)[number];

export function completionKindName(kind: number | undefined): CompletionKindName {
  return COMPLETION_KINDS[(kind ?? 1) - 1] ?? "Text";
}

/** LSP DiagnosticSeverity（1 错误 / 2 警告 / 3 提示 / 4 轻提示）→ Monaco `MarkerSeverity` 的成员名。 */
export function severityName(s: number | undefined): "Error" | "Warning" | "Info" | "Hint" {
  switch (s) {
    case 2:
      return "Warning";
    case 3:
      return "Info";
    case 4:
      return "Hint";
    default:
      return "Error";
  }
}

type MarkedString = string | { language: string; value: string };

/** hover / documentation 的内容（MarkupContent、MarkedString、数组）统一成 Markdown 段落列表。 */
export function contentsToMarkdown(contents: unknown): string[] {
  if (contents == null) return [];
  if (Array.isArray(contents)) return contents.flatMap(contentsToMarkdown);
  if (typeof contents === "string") return contents ? [contents] : [];
  const c = contents as { kind?: string; value?: string; language?: string };
  if (typeof c.value !== "string" || c.value === "") return [];
  // MarkedString 形式 { language, value } 要包成代码块；MarkupContent 本身就是 Markdown/纯文本
  if (c.language && !c.kind) return ["```" + c.language + "\n" + c.value + "\n```"];
  return [c.value];
}

export type { MarkedString };

/** 跳转目标：Location 与 LocationLink 统一成 { uri, range }。 */
export interface Target {
  uri: string;
  range: LspRange;
}

export function toTargets(result: unknown): Target[] {
  const list = Array.isArray(result) ? result : result ? [result] : [];
  const out: Target[] = [];
  for (const r of list as Record<string, unknown>[]) {
    const uri = (r.targetUri ?? r.uri) as string | undefined;
    const range = (r.targetSelectionRange ?? r.targetRange ?? r.range) as LspRange | undefined;
    if (uri && range) out.push({ uri, range });
  }
  return out;
}
