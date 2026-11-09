// 格式化目标解析与兜底排版。与 `formatAt` 的异步/撤销/错误提示分开：
// 这里是纯计算与批量编辑，易测，也避免 SqlEditor 因范围判断继续膨胀（组件体量门禁 300 行）。
import type { SqlLanguage } from "sql-formatter";
import { monaco } from "./monacoSetup";
import { formatSql } from "./sqlFormat";
import { pickStatement, splitStatements } from "./sqlSplit";
import { statementsOf } from "./sqlStmtCache";

/** 作用范围：`auto` 选区优先、否则整个脚本（原行为）；`current` 只看光标所在语句；`script` 整个脚本。 */
export type SqlFormatScope = "auto" | "current" | "script";

export interface FormatTarget {
  kind: "selection" | "statement" | "script";
  range: monaco.IRange;
  text: string;
}

/** 没有可格式化的内容（如 current 模式光标不在任何语句上）时返回 null。 */
export function formatTargetOf(
  model: monaco.editor.ITextModel,
  selection: monaco.Selection | null,
  position: monaco.Position | null,
  scope: SqlFormatScope,
): FormatTarget | null {
  if (scope === "current") {
    const stmt = position ? pickStatement(statementsOf(model), model.getOffsetAt(position)) : null;
    if (!stmt) return null;
    const start = model.getPositionAt(stmt.start);
    const end = model.getPositionAt(stmt.start + stmt.text.length);
    return { kind: "statement", range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: stmt.text };
  }
  if (scope === "auto" && selection && !selection.isEmpty()) {
    return { kind: "selection", range: selection, text: model.getValueInRange(selection) };
  }
  return { kind: "script", range: model.getFullModelRange(), text: model.getValue() };
}

export interface FormatEdit {
  range: monaco.IRange;
  text: string;
}

/**
 * 整篇解析失败时的兜底：逐条排版，解析不了的那几条跳过。
 *
 * 解析器遇到未闭合的引号/括号会整篇报错，而“最后一条还没写完”正是格式化整个脚本的常见时机；
 * 旧的手写 tokenizer 从不抛错，所以这里按语句拆分后逐条格式化，坏语句原样保留。
 * 语句之间的空白不改动（`linesBetweenQueries` 只在整个脚本能解析时生效）。
 */
export async function fallbackFormatEdits(
  model: monaco.editor.ITextModel,
  text: string,
  language: SqlLanguage,
): Promise<{ edits: FormatEdit[]; skipped: number; error: string | null }> {
  const edits: FormatEdit[] = [];
  let skipped = 0;
  let error: string | null = null;
  for (const stmt of splitStatements(text)) {
    try {
      const out = await formatSql(stmt.text, language);
      const start = model.getPositionAt(stmt.start);
      const end = model.getPositionAt(stmt.start + stmt.text.length);
      edits.push({ range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: out });
    } catch (e) {
      skipped += 1;
      error ??= e instanceof Error ? e.message : String(e);
    }
  }
  return { edits, skipped, error };
}

/** 一批编辑合并成一次撤销，不连带撤销之前的输入。 */
export function applyFormatEdits(
  editor: { pushUndoStop(): boolean; executeEdits(source: string, edits: FormatEdit[]): boolean | null },
  edits: FormatEdit[],
): void {
  editor.pushUndoStop();
  editor.executeEdits("ncforge-format", edits);
  editor.pushUndoStop();
}
