import { monaco } from "./monacoSetup";
import { connOf, rtOf, sqlColumnEpoch, sqlTabOf } from "./dbStore";
import { sqlAssistColumns } from "./sqlAssistColumns";
import { tabIdOfModel } from "./sqlModels";
import { analyzeSql, sqlCompletionAt, sqlScopeAt, sqlWildcardAt, type SqlSource, type SqlWildcard } from "./sqlScope";
import { sqlWordKind } from "./sqlLex";
import { dialectOfSqlModel, sqlAnalysisOf } from "./monacoSql";
import { getSqlFormatPrefs } from "./sqlFormatPrefs";
import { sqlIdentifier } from "./sqlCompletionContext";
import { sqlAssistObjectKey, sqlAssistScope, verifiedSqlSource } from "./sqlAssistLearning";
import { snippetEscape } from "./sqlTemplates";
import { isPlsql, splitStatements } from "./sqlSplit";
import { forgetSqlUsage, recordSqlUsage, rollbackSqlUsage, setSqlUsagePinned, sqlUsageKey, usageSnapshot, type SqlUsageReceipt } from "./sqlUsage";
import { listCommands } from "./commandRegistry";
import { wireSqlBatchAssist } from "./sqlBatchAssist";
import { wireSqlQueryCheckAssist } from "./sqlQueryCheckAssist";
import { wireSqlJoinMeaningAssist } from "./sqlJoinMeaningAssist";
import { wireSqlBillAssist } from "./sqlBillAssist";
import { wireSqlAssistGhost } from "./sqlAssistGhost";
import { toast } from "../components/ui/toast";

type Editor = monaco.editor.IStandaloneCodeEditor;
interface AcceptArgs { scope: string; key: string }
const accepts = new Map<Editor, (args: AcceptArgs) => void>();
let acceptCommand: monaco.IDisposable | undefined;
/** 补全列表里的动作条目只能带命令 id：命令执行时按焦点找到编辑器，交给它的 CodeAction 菜单。 */
const quickFixers = new Map<Editor, () => void>();
let quickFixCommand: monaco.IDisposable | undefined;

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

/** Per-editor listeners follow model changes; the shared completion command is registered once. */
export function wireSqlEditorAssist(editor: Editor): monaco.IDisposable {
  // 🔴 `glyphMargin` 必须显式打开：ESM 版 Monaco 把默认值改成了 false
  // （`monaco-editor/esm/vs/editor/editor.api.js` 里 `EditorOptions.glyphMargin.defaultValue = false`），
  // 而 Monaco 的 CodeAction 灯泡就是一个 `glyphMarginClassName` 装饰。少了这条槽，
  // 主子表联查 / 条件含义 / 批量 IN / 核对查询四个能力**在屏幕上没有任何入口**——
  // 只剩 Ctrl+. 一条没人知道的暗路。`on` 比默认的 `onCode` 多覆盖空行。
  editor.updateOptions({ quickSuggestions: { other: true, comments: false, strings: false }, quickSuggestionsDelay: 100,
    suggestSelection: "first", suggest: { showWords: false, localityBonus: false, shareSuggestSelections: false, selectionMode: "always" },
    glyphMargin: true, lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.On } });
  let disposed = false, composing = false, dirty: { start: number; end: number } | undefined;
  const accepted: { receipt: SqlUsageReceipt; tableKey: string; model: monaco.editor.ITextModel; at: number; start: number; end: number }[] = [];
  let typed: { receipt: SqlUsageReceipt; version: number } | undefined;
  const acceptedKeys = new Map<string, number>();
  let quick: monaco.editor.IQuickSuggestionsOptions | undefined;
  const disposables: monaco.IDisposable[] = [];
  disposables.push(wireSqlBatchAssist(editor));
  disposables.push(wireSqlQueryCheckAssist(editor));
  disposables.push(wireSqlJoinMeaningAssist(editor));
  // 裸表名上的「一键生成主子表联查」：模板只在新语句开头打表名时才进补全，
  // 用户按 `SELECT * FROM` 的常规写法撞不到，这里补一个光标旁的入口。
  disposables.push(wireSqlBillAssist(editor));
  // 行内提示：表名后的「⌥ 主子表联查」chip 与 JOIN 条件的行尾说明。
  disposables.push(wireSqlAssistGhost(editor));
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
    /**
     * 从候选列表点选表名后，Monaco 会把补全框关掉 —— 用户「用补全打完 `po_order`」
     * 就再也看不到表名说明里的「N 个关联表」和 JOIN 片段，只有把名字逐字打全才会。
     * 选完立刻再唤一次：`FROM` 位置给「接上子表」，裸表名位置给整条联查模板。
     *
     * 字段项不重弹（每次选字段都多一个框）；光标已离开表名末尾也不弹。
     */
    if (!field && (sqlCompletionAt(state.analysis, state.offset).kind === "table" || !sqlScopeAt(state.analysis, state.offset))) {
      setTimeout(() => {
        if (disposed || editor.getModel() !== state.model) return;
        const position = editor.getPosition();
        if (!position || state.model.getOffsetAt(position) !== state.offset) return;
        editor.trigger("sql-assist", "editor.action.triggerSuggest", {});
      }, 0);
    }
  });
  if (!acceptCommand) acceptCommand = monaco.editor.registerCommand("ncforge.sql.accept", (_accessor, args: AcceptArgs) => {
    if (!args || typeof args.scope !== "string" || typeof args.key !== "string") return;
    for (const [candidate, accept] of accepts) if (candidate.hasTextFocus()) { accept(args); break; }
  });
  // 补全列表末尾的「动作」条目只带命令 id，真正的菜单仍由 Monaco 的 CodeAction 出：
  // 这里只负责把焦点编辑器交出去，判定与实现都留在原 provider 里，不复制一份。
  quickFixers.set(editor, () => editor.trigger("sql-assist", "editor.action.quickFix", {}));
  if (!quickFixCommand) quickFixCommand = monaco.editor.registerCommand("ncforge.sql.quickFix", () => {
    for (const [candidate, run] of quickFixers) if (candidate.hasTextFocus()) { run(); break; }
  });
  disposables.push(editor.onDidChangeModel(reset));
  /**
   * 空格 / 逗号后的补全：只在「该出表名的地方」主动唤一次。
   *
   * 原先靠 completion provider 的 `triggerCharacters: [" "]`，等于 WHERE 里每敲一个空格
   * 都开一次面板；用户按几次 Esc 之后就再也不指望它弹。这里按前一个词判定：
   * FROM / JOIN / INTO / UPDATE / TABLE 之后要表名，逗号之后要下一个表名或字段。
   * 其余位置交给 Monaco 的打字即触发（quickSuggestions），不再额外开框。
   *
   * 延到下一拍再唤，与「接受补全后重弹」走同一条已验证的路径。
   */
  const suggestAfterSeparator = (event: monaco.editor.IModelContentChangedEvent) => {
    if (composing || !event.changes.some(c => c.text === " " || c.text === ",")) return;
    const model = editor.getModel();
    if (!model) return;
    setTimeout(() => {
      if (disposed || editor.getModel() !== model) return;
      const state = current(editor);
      if (!state) return;
      const before = state.analysis.tokens.filter(t => t.end <= state.offset && !["space", "comment", "hint"].includes(t.kind)).pop();
      if (!before) return;
      if (before.text !== "," && !["FROM", "JOIN", "INTO", "UPDATE", "TABLE"].includes(before.text.toUpperCase())) return;
      editor.trigger("sql-assist", "editor.action.triggerSuggest", {});
    }, 0);
  };
  disposables.push(editor.onDidChangeModelContent(event => {
    // setValue/history loading flushes the model; that is not a user's typing event.
    if (event.isFlush) { reset(); return; }
    suggestAfterSeparator(event);
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
    let source = sourceAt(state), wildcard: SqlWildcard | undefined, qualifier: string | undefined;
    if (!insert) {
      // 判定与表名旁的 chip 共用同一份：否则会出现「chip 显示、点了却提示请把光标放在 * 上」。
      wildcard = sqlWildcardAt(state.analysis, state.offset);
      if (!wildcard) { toast("请将光标放在独立的 * 或别名.* 上", "info"); return; }
      if (!wildcard.qualifier && (scope?.sources.length ?? 0) > 1) { toast("多表查询请先使用别名.*，例如 m.*，再展开字段", "info"); return; }
      source = wildcard.source; qualifier = wildcard.qualifier;
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
      const token = state.analysis.tokens[wildcard!.token];
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
    quickFixers.delete(editor);
    if (!accepts.size) { acceptCommand?.dispose(); acceptCommand = undefined; }
    if (!quickFixers.size) { quickFixCommand?.dispose(); quickFixCommand = undefined; }
  } };
}
