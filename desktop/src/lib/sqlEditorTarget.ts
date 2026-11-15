/**
 * SQL 编辑器的「取执行范围」与「按范围格式化」：只依赖编辑器实例，不碰 React 生命周期。
 * 从 `components/db/SqlEditor.tsx` 搬出来（2026-11-13），组件只管建编辑器、换 model 与句柄。
 */
import type { monaco } from "./monacoSetup";
import { tabIdOfModel } from "./sqlModels";
import { pickStatement, splitStatements, type Stmt } from "./sqlSplit";
import { statementsOf } from "./sqlStmtCache";
import { applyFormatEdits, fallbackFormatEdits, formatTargetOf, type SqlFormatScope } from "./sqlFormatTarget";
import { formatSql, sqlLanguageOf } from "./sqlFormat";
import { connOf, sqlTabOf } from "./dbStore";
import { toast } from "../components/ui/toast";

export interface RunStmt {
  text: string;
  startLine: number;
  endLine?: number;
  editorVersion?: number;
  editorSql?: string;
  startOffset?: number;
  endOffset?: number;
}

export interface SqlExecutionScope {
  tabId: string;
  selected: boolean;
  statements: RunStmt[];
}

export type SqlRunMode = "auto" | "current" | "script";

type Editor = monaco.editor.IStandaloneCodeEditor;

const modelSources = new WeakMap<monaco.editor.ITextModel, { editorVersion: number; editorSql: string }>();

/** auto：选中内容或全部；current：仅光标语句；script：全部。 */
export function targetOf(editor: Editor, mode: SqlRunMode): RunStmt[] {
  const model = editor.getModel();
  if (!model) return [];
  const editorVersion = model.getVersionId();
  let source = modelSources.get(model);
  // 范围随光标更新，整篇 SQL 只随版本更新，避免每次移动都重新读取大脚本。
  if (!source || source.editorVersion !== editorVersion) {
    source = { editorVersion, editorSql: model.getValue() };
    modelSources.set(model, source);
  }
  const statement = (stmt: Stmt, offset = 0, lineOffset = 0): RunStmt => ({
    ...source, text: stmt.text, startLine: stmt.startLine + lineOffset, endLine: stmt.endLine + lineOffset,
    startOffset: stmt.start + offset, endOffset: stmt.end + offset,
  });
  const sel = editor.getSelection();
  if (mode === "auto" && sel && !sel.isEmpty()) {
    const part = model.getValueInRange(sel);
    const offset = model.getOffsetAt(sel.getStartPosition());
    return splitStatements(part).map((s) => statement(s, offset, sel.startLineNumber - 1));
  }
  if (mode === "script") return statementsOf(model).map((s) => statement(s));
  const pos = editor.getPosition();
  const s = pos ? pickStatement(statementsOf(model), model.getOffsetAt(pos)) : null;
  return s ? [statement(s)] : [];
}

/** 按范围格式化（范围解析见 lib/sqlFormatTarget）。整篇解析失败时逐条兜底，坏语句保留原文。 */
export async function formatAt(editor: Editor, scope: SqlFormatScope = "auto") {
  const model = editor.getModel();
  if (!model) return;
  const target = formatTargetOf(model, editor.getSelection(), editor.getPosition(), scope);
  if (!target) {
    toast("光标处没有可格式化的 SQL 语句", "warning");
    return;
  }
  const connId = sqlTabOf(tabIdOfModel(model))?.connId;
  const language = sqlLanguageOf(connId ? connOf(connId)?.url ?? "" : "");
  const version = model.getVersionId();
  const stale = () => editor.getModel() !== model || model.getVersionId() !== version;
  let text: string | null = null;
  let error = "";
  try { text = await formatSql(target.text, language); }
  catch (e) { error = e instanceof Error ? e.message : String(e); }
  if (stale()) return;
  if (text !== null) { applyFormatEdits(editor, [{ range: target.range, text }]); return; }
  if (target.kind !== "script") { toast(`SQL 格式化失败：${error}`, "warning"); return; }
  // 整个脚本里有一条没写完（引号/括号未闭合）会整篇解析失败：逐条排版，只跳过那一条。
  const result = await fallbackFormatEdits(model, target.text, language);
  if (stale()) return;
  if (result.edits.length === 0) { toast(`SQL 格式化失败：${result.error ?? error}`, "warning"); return; }
  applyFormatEdits(editor, result.edits);
  if (result.skipped > 0) toast(`已格式化 ${result.edits.length} 条语句，跳过 ${result.skipped} 条无法解析的`, "warning");
}
