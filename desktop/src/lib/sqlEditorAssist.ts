import { monaco } from "./monacoSetup";
import { connOf, rtOf, sqlColumnEpoch, sqlTabOf } from "./dbStore";
import { sqlAssistColumns } from "./sqlAssistColumns";
import { tabIdOfModel } from "./sqlModels";
import { analyzeSql, resolveSqlQualifier, sqlScopeAt, type SqlSource } from "./sqlScope";
import { isSqlName, sqlName, sqlWordKind } from "./sqlLex";
import { dialectOfSqlModel, sqlAnalysisOf } from "./monacoSql";
import { getSqlFormatPrefs } from "./sqlFormatPrefs";
import { sqlIdentifier } from "./sqlCompletionContext";
import { sqlAssistObjectKey, sqlAssistScope, verifiedSqlSource } from "./sqlAssistLearning";
import { isPlsql, splitStatements } from "./sqlSplit";
import { forgetSqlUsage, recordSqlUsage, rollbackSqlUsage, setSqlUsagePinned, sqlUsageKey, usageSnapshot, type SqlUsageReceipt } from "./sqlUsage";
import { toast } from "../components/ui/toast";
import { listCommands } from "./commandRegistry";

type Editor = monaco.editor.IStandaloneCodeEditor;
interface AcceptArgs { scope: string; key: string }
const accepts = new Map<Editor, (args: AcceptArgs) => void>();
let acceptCommand: monaco.IDisposable | undefined;

function current(editor: Editor) {
  const model = editor.getModel(), position = editor.getPosition();
  const tab = model && sqlTabOf(tabIdOfModel(model)), conn = connOf(tab?.connId);
  if (!model || !position || !tab?.connId || !conn) return null;
  const dialect = dialectOfSqlModel(model), sql = model.getValue();
  const schema = rtOf(tab.connId).currentSchema ?? rtOf(tab.connId).info?.schema;
  return { model, connId: tab.connId, dialect, schema, sql, analysis: sqlAnalysisOf(model), offset: model.getOffsetAt(position), scope: sqlAssistScope(tab.connId) };
}
function sourceAt(state: NonNullable<ReturnType<typeof current>>): SqlSource | undefined {
  const sources = sqlScopeAt(state.analysis, state.offset)?.sources ?? [];
  const under = sources.find(s => { const t = state.analysis.tokens[s.declaration]; return t && t.start <= state.offset && t.end >= state.offset; });
  return under ?? (sources.length === 1 ? sources[0] : undefined);
}
function rangeOf(model: monaco.editor.ITextModel, start: number, end: number): monaco.IRange {
  const a = model.getPositionAt(start), b = model.getPositionAt(end);
  return { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column };
}
const snippetEscape = (text: string) => text.replace(/[\\$}]/g, "\\$&");

/** Per-editor listeners follow model changes; the shared completion command is registered once. */
export function wireSqlEditorAssist(editor: Editor): monaco.IDisposable {
  editor.updateOptions({ quickSuggestions: { other: true, comments: false, strings: false }, quickSuggestionsDelay: 100,
    suggestSelection: "first", suggest: { showWords: false, localityBonus: false, shareSuggestSelections: false, selectionMode: "always" } });
  let disposed = false, composing = false, dirty: { start: number; end: number } | undefined;
  const accepted: { receipt: SqlUsageReceipt; tableKey: string; model: monaco.editor.ITextModel; at: number; start: number; end: number }[] = [];
  let typed: { receipt: SqlUsageReceipt; version: number } | undefined;
  const acceptedKeys = new Map<string, number>();
  let quick: monaco.editor.IQuickSuggestionsOptions | undefined;
  const disposables: monaco.IDisposable[] = [];
  const reset = () => { dirty = undefined; accepted.length = 0; typed = undefined; acceptedKeys.clear(); };

  accepts.set(editor, args => {
    const state = current(editor);
    if (!state?.scope || args.scope !== state.scope) return;
    let parts: unknown;
    try { parts = JSON.parse(args.key); } catch { return; }
    if (!Array.isArray(parts) || parts.length !== 3 || parts.some(p => typeof p !== "string")) return;
    const [table, field] = parts as string[];
    const source = analyzeSql(`SELECT * FROM ${table}`, state.dialect).scopes[0]?.sources[0];
    if (!source || !verifiedSqlSource(state.connId, source)) return;
    // Monaco fires content/cursor events before the completion command. Replace that weak signal.
    if (typed?.version === state.model.getVersionId() && typed.receipt.key === sqlUsageKey(table)) { rollbackSqlUsage(typed.receipt); typed = undefined; }
    const receipt = recordSqlUsage(args.scope, args.key, "accept");
    if (!receipt) return;
    const token = state.analysis.tokens.find(t => t.start < state.offset && t.end >= state.offset);
    accepted.push({ receipt, tableKey: sqlUsageKey(table), model: state.model, at: Date.now(), start: token?.start ?? state.offset, end: token?.end ?? state.offset });
    if (accepted.length > 32) accepted.shift();
    acceptedKeys.set(sqlUsageKey(table), Date.now());
    if (field) acceptedKeys.set(args.key, Date.now());
    dirty = undefined;
  });
  if (!acceptCommand) acceptCommand = monaco.editor.registerCommand("ncforge.sql.accept", (_accessor, args: AcceptArgs) => {
    if (!args || typeof args.scope !== "string" || typeof args.key !== "string") return;
    for (const [candidate, accept] of accepts) if (candidate.hasTextFocus()) { accept(args); break; }
  });
  disposables.push(editor.onDidChangeModel(reset));
  disposables.push(editor.onDidChangeModelContent(event => {
    // setValue/history loading flushes the model; that is not a user's typing event.
    if (event.isFlush) { reset(); return; }
    // Roll back newest receipts first so consecutive undo also restores earlier accepts.
    for (let i = accepted.length - 1; i >= 0; i--) {
      const item = accepted[i];
      const immediate = Date.now() - item.at < 5000 && editor.getModel() === item.model;
      const removed = event.changes.some(c => c.rangeLength > 0 && c.rangeOffset < item.end && c.rangeOffset + c.rangeLength > item.start);
      const renamed = event.changes.some(c => c.rangeOffset === item.end && /^[\p{L}\p{N}_$#]/u.test(c.text));
      if (immediate && (removed || renamed)) {
        rollbackSqlUsage(item.receipt); acceptedKeys.delete(item.receipt.key); acceptedKeys.delete(item.tableKey); accepted.splice(i, 1);
      } else if (immediate) {
        const shift = event.changes.filter(c => c.rangeOffset < item.start).reduce((sum, c) => sum + c.text.length - c.rangeLength, 0);
        item.start += shift; item.end += shift;
      } else accepted.splice(i, 1);
    }
    if (event.isUndoing || event.isRedoing) { dirty = undefined; return; }
    for (const c of event.changes) {
      const end = c.rangeOffset + Math.max(c.text.length, c.rangeLength);
      dirty = { start: Math.min(dirty?.start ?? c.rangeOffset, c.rangeOffset), end: Math.max(dirty?.end ?? end, end) };
    }
  }));
  disposables.push(editor.onDidChangeCursorPosition(() => {
    if (!dirty || composing) return;
    const state = current(editor);
    if (!state?.scope) return;
    for (const scope of state.analysis.scopes) for (const source of scope.sources) {
      const token = state.analysis.tokens[source.declaration];
      if (!token || state.offset >= token.start && state.offset <= token.end || dirty.start > token.end + 1 || dirty.end < token.start) continue;
      let next = source.declaration + 1;
      while (next < state.analysis.tokens.length && ["space", "comment", "hint"].includes(state.analysis.tokens[next].kind)) next++;
      if (state.analysis.tokens[next]?.text === ".") continue;
      const verified = verifiedSqlSource(state.connId, source);
      if (!verified) continue;
      const key = sqlUsageKey(sqlAssistObjectKey(verified, state.schema));
      const acceptedAt = acceptedKeys.get(key);
      if (acceptedAt !== undefined && Date.now() - acceptedAt < 5000) continue;
      acceptedKeys.delete(key);
      const receipt = recordSqlUsage(state.scope, key, "type");
      if (receipt) typed = { receipt, version: state.model.getVersionId() };
    }
    // Keep the edit pending while the caret is still finishing an identifier.
    const token = state.analysis.tokens.find(t => t.start <= state.offset && t.end >= state.offset && ["identifier", "quoted"].includes(t.kind));
    if (!token) dirty = undefined;
  }));
  disposables.push(editor.onDidCompositionStart(() => {
    composing = true; quick = editor.getOption(monaco.editor.EditorOption.quickSuggestions);
    editor.trigger("sql-assist", "hideSuggestWidget", {});
    editor.updateOptions({ quickSuggestions: false });
  }));
  disposables.push(editor.onDidCompositionEnd(() => {
    composing = false;
    if (quick) editor.updateOptions({ quickSuggestions: quick });
    quick = undefined; editor.trigger("sql-assist", "editor.action.triggerSuggest", {});
  }));

  async function fields(insert: boolean) {
    const state = current(editor);
    if (!state) return;
    const scope = sqlScopeAt(state.analysis, state.offset);
    let source = sourceAt(state), star: number | undefined, qualifier: string | undefined;
    if (!insert) {
      star = state.analysis.tokens.findIndex(t => t.text === "*" && t.start <= state.offset && t.end >= state.offset);
      if (star < 0 || !scope?.indices.includes(star) || state.analysis.tokens[scope.select].text.toUpperCase() !== "SELECT" || scope.indices.some(i => i < star! && state.analysis.tokens[i].text.toUpperCase() === "FROM")) { toast("请将光标放在 SELECT 的 * 上", "info"); return; }
      const ids = scope.indices, p = ids.indexOf(star), dot = state.analysis.tokens[ids[p - 1]], alias = state.analysis.tokens[ids[p - 2]];
      const qualified = dot?.text === "." && isSqlName(alias);
      const before = state.analysis.tokens[ids[p - (qualified ? 3 : 1)]], after = state.analysis.tokens[ids[p + 1]];
      // A wildcard occupies an entire projection item; multiplication never does.
      if (!["SELECT", "DISTINCT", "ALL", ","].includes(before?.text.toUpperCase() ?? "") || after && !["FROM", ",", ";"].includes(after.text.toUpperCase())) { toast("请将光标放在独立的 * 或别名.* 上", "info"); return; }
      if (qualified) { qualifier = alias.text; source = resolveSqlQualifier(state.analysis, state.offset, sqlName(alias), alias.text); }
      if (!qualifier && scope.sources.length > 1) { toast("多表查询请先使用别名.*，例如 m.*，再展开字段", "info"); return; }
    }
    const verified = source && verifiedSqlSource(state.connId, source);
    if (!verified || !scope) { toast("请在一张已确认的表或其查询中使用此操作", "info"); return; }
    // The existing uppercase column-cache key conflates quoted objects; never edit from that cache.
    if (verified.quoted) { toast("带引号的表请先手动确认字段", "info"); return; }
    const version = state.model.getVersionId(), capturedScope = state.scope, epoch = sqlColumnEpoch(state.connId);
    // Refresh/reconnect can change fields without changing the connection/schema identity.
    const stillCurrent = () => !disposed && !state.model.isDisposed() && editor.getModel() === state.model && state.model.getVersionId() === version && sqlColumnEpoch(state.connId) === epoch && sqlAssistScope(state.connId) === capturedScope && sqlTabOf(tabIdOfModel(state.model))?.connId === state.connId && !!editor.getPosition() && state.model.getOffsetAt(editor.getPosition()!) === state.offset;
    let cols;
    try { cols = await sqlAssistColumns(state.connId, verified.tableRef, stillCurrent, true); }
    catch { if (stillCurrent()) toast("暂时无法读取字段，请刷新表结构后重试", "warning"); return; }
    if (!stillCurrent()) return;
    if (!cols.length) { toast("这张表暂时没有可用字段", "info"); return; }
    const names = cols.map(c => {
      const folded = state.dialect !== "postgresql" && /^[A-Z_][A-Z0-9_$#]*$/.test(c.name) ? c.name.toLowerCase() : c.name;
      return sqlIdentifier(sqlWordKind(folded, state.dialect) === "identifier" ? folded : c.name, state.dialect);
    });
    editor.pushUndoStop();
    if (insert) {
      const statement = splitStatements(state.sql).find(s => s.start <= state.offset && s.end >= state.offset);
      if (!statement || isPlsql(statement.text)) { toast("请在普通 SQL 语句中生成 INSERT 模板", "info"); return; }
      const keyword = (text: string) => getSqlFormatPrefs().keywordCase === "lower" ? text.toLowerCase() : text;
      const values = cols.map((c, i) => "${" + (i + 1) + ":" + snippetEscape(c.name) + "}");
      const end = statement.end;
      const template = `${state.sql[end - 1] === ";" ? "" : ";"}\n\n${keyword("INSERT INTO")} ${snippetEscape(verified.tableRef)} (${names.map(snippetEscape).join(", ")})\n${keyword("VALUES")} (${values.join(", ")});$0`;
      const snippet = editor.getContribution("snippetController2") as unknown as { insert(template: string): void } | null;
      if (!snippet) { toast("模板编辑暂不可用，请稍后重试", "warning"); return; }
      editor.setPosition(state.model.getPositionAt(end)); editor.setSelection(rangeOf(state.model, end, end));
      snippet.insert(template);
    } else {
      const token = state.analysis.tokens[star!];
      const prefix = qualifier ? `${qualifier}.` : "";
      // The first qualifier already precedes the replaced star.
      const text = names.map((n, i) => `${i ? prefix : ""}${n}`).join(", ");
      editor.executeEdits("sql-assist", [{ range: rangeOf(state.model, token.start, token.end), text }]);
    }
    editor.pushUndoStop(); editor.focus();
  }
  function memory(forget: boolean) {
    const state = current(editor), source = state && sourceAt(state);
    const verified = state && source && verifiedSqlSource(state.connId, source);
    if (!state?.scope || !verified) { toast("请将光标放在已确认的表名上", "info"); return; }
    const key = sqlUsageKey(sqlAssistObjectKey(verified, state.schema));
    if (forget) { forgetSqlUsage(state.scope, key); acceptedKeys.delete(key); toast("已忘记这张表的使用偏好", "success"); }
    else { const pinned = !usageSnapshot(state.scope)[key]?.pinned; setSqlUsagePinned(state.scope, key, pinned); toast(pinned ? "已固定到表名提示前列" : "已取消固定", "success"); }
  }
  for (const [id, label, run] of [
    ["ncforge.sql.expandStar", "展开 * 为字段列表", () => fields(false)],
    ["ncforge.sql.insertTemplate", "生成 INSERT 模板", () => fields(true)],
    ["ncforge.sql.pinTable", "固定 / 取消固定当前表", () => memory(false)],
    ["ncforge.sql.forgetTable", "忘记当前表的使用偏好", () => memory(true)],
    // 编辑器里按 `?` 会被 Monaco 吃掉（它是文本输入），所以在右键菜单里给一个入口，
    // 与外壳的 `?` 打开的是同一张表。
    ["ncforge.sql.shortcuts", "快捷键速查", () => listCommands().find((c) => c.id === "help.shortcuts")?.run()],
  ] as const) disposables.push(editor.addAction({ id, label, contextMenuGroupId: "navigation", contextMenuOrder: 4, run }));
  return { dispose() {
    if (disposed) return;
    disposed = true;
    if (quick) editor.updateOptions({ quickSuggestions: quick });
    disposables.forEach(d => d.dispose()); accepts.delete(editor); reset();
    if (!accepts.size) { acceptCommand?.dispose(); acceptCommand = undefined; }
  } };
}
