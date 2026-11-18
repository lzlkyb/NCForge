import { monaco } from "./monacoSetup";
import { connOf, rtOf, sqlColumnEpoch, sqlTabOf } from "./dbStore";
import { sqlAssistColumns, sqlFieldIdentifiers } from "./sqlAssistColumns";
import { tabIdOfModel } from "./sqlModels";
import { analyzeSql, sqlCompletionAt, sqlScopeAt, sqlWildcardAt, sqlWildcardInScope, type SqlSource, type SqlWildcard } from "./sqlScope";
import { dialectOfSqlModel, sqlAnalysisOf } from "./monacoSql";
import { getSqlFormatPrefs } from "./sqlFormatPrefs";
import { completionContext } from "./sqlCompletionContext";
import { sqlPredicateContext } from "./sqlPredicateContext";
import { sqlAssistObjectKey, sqlAssistScope, verifiedSqlSource } from "./sqlAssistLearning";
import { getSqlTemplatesEnabled, snippetEscape } from "./sqlTemplates";
import { isPlsql, splitStatements } from "./sqlSplit";
import { forgetSqlUsage, recordSqlUsage, rollbackSqlUsage, setSqlUsagePinned, sqlUsageKey, usageSnapshot, type SqlUsageReceipt } from "./sqlUsage";
import { addSnippet } from "./dbSnippets";
import { listCommands } from "./commandRegistry";
import { wireSqlBatchAssist } from "./sqlBatchAssist";
import { wireSqlQueryCheckAssist } from "./sqlQueryCheckAssist";
import { wireSqlJoinMeaningAssist } from "./sqlJoinMeaningAssist";
import { wireSqlBillAssist } from "./sqlBillAssist";
import { wireSqlSelectionAssist } from "./sqlSelectionAssist";
import { wireSqlAssistGhost } from "./sqlAssistGhost";
import { peekSqlBusinessMetadata, readSqlBusinessMetadata } from "./sqlBusiness";
import { toast } from "../components/ui/toast";

type Editor = monaco.editor.IStandaloneCodeEditor;
interface AcceptArgs { scope: string; key: string; followOperator?: boolean }
const accepts = new Map<Editor, (args: AcceptArgs) => void>();
let acceptCommand: monaco.IDisposable | undefined;
/** 补全列表里的动作条目只能带命令 id：命令执行时按焦点找到编辑器，交给它的 CodeAction 菜单。 */
const quickFixers = new Map<Editor, () => void>();
let quickFixCommand: monaco.IDisposable | undefined;
/** 同上，但用来直接跑一条 editor action（展开 `*`、INSERT 模板这类单值动作）。 */
const actionRunners = new Map<Editor, (actionId: string) => void>();
let runActionCommand: monaco.IDisposable | undefined;

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
    suggestSelection: "first", suggest: { showWords: false, localityBonus: false, shareSuggestSelections: false, selectionMode: "always", showStatusBar: true },
    glyphMargin: true, lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.On } });
  let disposed = false, composing = false, dirty: { start: number; end: number } | undefined;
  const accepted: { receipt: SqlUsageReceipt; tableKey: string; model: monaco.editor.ITextModel; at: number; start: number; end: number }[] = [];
  let typed: { receipt: SqlUsageReceipt; version: number } | undefined;
  const acceptedKeys = new Map<string, number>();
  let quick: monaco.editor.IQuickSuggestionsOptions | undefined;
  let pendingSuggest: ReturnType<typeof setTimeout> | undefined;
  let relationRequest = 0;
  let dismissed: { model: monaco.editor.ITextModel; version: number; offset: number } | undefined;
  const disposables: monaco.IDisposable[] = [];
  disposables.push(wireSqlBatchAssist(editor));
  disposables.push(wireSqlQueryCheckAssist(editor));
  disposables.push(wireSqlJoinMeaningAssist(editor));
  // 裸表名上的「一键生成主子表联查」：模板只在新语句开头打表名时才进补全，
  // 用户按 `SELECT * FROM` 的常规写法撞不到，这里补一个光标旁的入口。
  disposables.push(wireSqlBillAssist(editor));
  // 选区类动作（转 IN / 查重 / 汇总）原先只有右键菜单一条路，接到 Ctrl+. 下。
  disposables.push(wireSqlSelectionAssist(editor));
  // 行内提示：表名后的「主子表联查」chip 与 JOIN 条件的行尾说明。
  disposables.push(wireSqlAssistGhost(editor));
  const reset = () => { relationRequest++; clearTimeout(pendingSuggest); dismissed = undefined; dirty = undefined; accepted.length = 0; typed = undefined; acceptedKeys.clear(); };
  const suggestAt = (model: monaco.editor.ITextModel, offset: number, eligible: (state: NonNullable<ReturnType<typeof current>>) => boolean, checkLateRelations = false) => {
    clearTimeout(pendingSuggest);
    const version = model.getVersionId();
    pendingSuggest = setTimeout(() => {
      if (disposed || composing || !editor.hasTextFocus() || editor.getModel() !== model || model.getVersionId() !== version
        || dismissed?.model === model && dismissed.version === version && dismissed.offset === offset) return;
      const state = current(editor);
      if (!state || state.offset !== offset || editor.getSelection()?.isEmpty() === false) return;
      const invoke = eligible(state);
      if (checkLateRelations) watchRelations(state, invoke);
      if (!invoke) return;
      editor.trigger("sql-assist", "editor.action.triggerSuggest", {});
    }, 0);
  };
  const expandableAt = (state: NonNullable<ReturnType<typeof current>>) => {
    const source = sqlWildcardAt(state.analysis, state.offset)?.source;
    const verified = source && rtOf(state.connId).status === "connected" && verifiedSqlSource(state.connId, source);
    return !!verified && !verified.quoted;
  };
  const closeSuggestions = () => {
    // Monaco's Escape keybinding only cancels visible widgets. Pending providers must also stop.
    const controller = editor.getContribution("editor.contrib.suggestController") as unknown as { cancelSuggestWidget?(): void } | null;
    if (controller?.cancelSuggestWidget) controller.cancelSuggestWidget();
    else editor.trigger("sql-assist", "hideSuggestWidget", {});
  };
  function watchRelations(state: NonNullable<ReturnType<typeof current>>, invoked: boolean) {
    const { analysis, model, offset, connId, scope, dialect } = state;
    if (!scope || dialect !== "plsql" || rtOf(connId).status !== "connected" || !getSqlTemplatesEnabled()) return;
    const query = sqlScopeAt(analysis, offset), source = query?.sources[0];
    if (!query || analysis.tokens[query.select]?.text.toUpperCase() !== "SELECT" || !source || source.alias || analysis.tokens[source.declaration]?.end !== offset) return;
    const verified = verifiedSqlSource(connId, source);
    if (!verified || verified.quoted) return;
    const table = verified.table.toLowerCase();
    if (peekSqlBusinessMetadata(connId, scope, table)) return;
    const version = model.getVersionId(), epoch = sqlColumnEpoch(connId), request = ++relationRequest, started = Date.now();
    const sameScope = () => !disposed && rtOf(connId).status === "connected" && sqlColumnEpoch(connId) === epoch && sqlAssistScope(connId) === scope;
    void readSqlBusinessMetadata(connId, scope, table, sameScope).then(metadata => {
      // The first completion request is already waiting briefly for this same shared read.
      // Refresh only on a late result and leave any user selection or dismissal alone.
      if (!metadata?.relations.length || Date.now() - started < (invoked ? 500 : 220) || relationRequest !== request || !sameScope() || composing
        || editor.getModel() !== model || model.getVersionId() !== version) return;
      suggestAt(model, offset, next => next.connId === connId && getSqlTemplatesEnabled());
    }).catch(() => undefined);
  }
  disposables.push(editor.onKeyDown(event => {
    const key = event.browserEvent.key;
    if (["Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab", "Enter"].includes(key)) relationRequest++;
    if (key !== "Escape") return;
    clearTimeout(pendingSuggest);
    const model = editor.getModel(), position = editor.getPosition();
    if (model && position) dismissed = { model, version: model.getVersionId(), offset: model.getOffsetAt(position) };
    closeSuggestions();
  }));

  accepts.set(editor, args => {
    const state = current(editor);
    if (!state?.scope || args.scope !== state.scope) return;
    let parts: unknown;
    try { parts = JSON.parse(args.key); } catch { return; }
    if (!Array.isArray(parts) || parts.length !== 3 || parts.some(p => typeof p !== "string")) return;
    const [table, field] = parts as string[];
    const source = analyzeSql(`SELECT * FROM ${table}`, state.dialect).scopes[0]?.sources[0];
    if (!source || !verifiedSqlSource(state.connId, source)) return;
    // Continue editing even when usage recording is disabled or deduplicates the acceptance.
    if (field && args.followOperator) suggestAt(state.model, state.offset, next =>
      getSqlTemplatesEnabled() && sqlPredicateContext(next.analysis, next.offset, completionContext(next.analysis, next.offset, next.dialect).clause)?.kind === "operator");
    else if (!field && (sqlCompletionAt(state.analysis, state.offset).kind === "table" || !sqlScopeAt(state.analysis, state.offset))) {
      suggestAt(state.model, state.offset, () => true, true);
    }
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
  // 补全列表末尾的「动作」条目只带命令 id，真正的菜单仍由 Monaco 的 CodeAction 出：
  // 这里只负责把焦点编辑器交出去，判定与实现都留在原 provider 里，不复制一份。
  quickFixers.set(editor, () => editor.trigger("sql-assist", "editor.action.quickFix", {}));
  if (!quickFixCommand) quickFixCommand = monaco.editor.registerCommand("ncforge.sql.quickFix", () => {
    for (const [candidate, run] of quickFixers) if (candidate.hasTextFocus()) { run(); break; }
  });
  // 「展开 * 为字段列表」「生成 INSERT 模板」是单值动作，没有「多个子表挑一个」的问题，
  // 走菜单反而多一次点击。补全项直接带这个命令，落到同一个已注册的 editor action。
  actionRunners.set(editor, id => { void editor.getAction(id)?.run(); });
  if (!runActionCommand) runActionCommand = monaco.editor.registerCommand("ncforge.sql.runAction", (_accessor, actionId: string) => {
    if (typeof actionId !== "string") return;
    for (const [candidate, run] of actionRunners) if (candidate.hasTextFocus()) { run(actionId); break; }
  });
  disposables.push(editor.onDidChangeModel(reset));
  /**
   * 在表名、字段、关联条件和运算符的输入边界接续补全。
   *
   * 原先靠 completion provider 的 `triggerCharacters: [" "]`，等于 WHERE 里每敲一个空格
   * 都开一次面板；用户按几次 Esc 之后就再也不指望它弹。这里按前一个词判定：
   * FROM / JOIN / INTO / UPDATE / TABLE 之后要表名，逗号之后要下一个表名或字段。
   * WHERE / ON 只在可补条件的位置主动打开，其余位置交给 Monaco 的普通补全。
   *
   * 延到下一拍再唤，与「接受补全后重弹」走同一条已验证的路径。
   */
  const suggestAfterTyping = (event: monaco.editor.IModelContentChangedEvent) => {
    const change = event.changes.length === 1 ? event.changes[0] : undefined;
    if (composing || event.isUndoing || event.isRedoing || !change) return;
    const model = editor.getModel();
    if (!model) return;
    if (/^[\p{L}\p{N}_$#]$/u.test(change.text)) {
      suggestAt(model, change.rangeOffset + change.text.length, () => false, true);
      return;
    }
    if (![" ", ",", "*"].includes(change.text)) return;
    suggestAt(model, change.rangeOffset + change.text.length, state => {
      if (change.text === "*") return expandableAt(state);
      const ctx = completionContext(state.analysis, state.offset, state.dialect);
      if (ctx.kind === "none") return false;
      const before = state.analysis.tokens.filter(t => t.end <= state.offset && !["space", "comment", "hint"].includes(t.kind)).pop();
      if (before && (before.text === "," || ["FROM", "JOIN", "INTO", "UPDATE", "TABLE"].includes(before.text.toUpperCase()))) return true;
      const predicate = sqlPredicateContext(state.analysis, state.offset, ctx.clause);
      return predicate?.kind === "field" || predicate?.kind === "operator" && getSqlTemplatesEnabled();
    });
  };
  disposables.push(editor.onDidChangeModelContent(event => {
    // setValue/history loading flushes the model; that is not a user's typing event.
    if (event.isFlush) { reset(); return; }
    suggestAfterTyping(event);
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
  disposables.push(editor.onDidChangeCursorPosition(event => {
    if (event?.source === "keyboard" && !composing) {
      const state = current(editor);
      if (state && expandableAt(state)) suggestAt(state.model, state.offset, expandableAt);
    }
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
    relationRequest++;
    clearTimeout(pendingSuggest);
    composing = true; quick = editor.getOption(monaco.editor.EditorOption.quickSuggestions);
    closeSuggestions();
    editor.updateOptions({ quickSuggestions: false });
  }));
  disposables.push(editor.onDidCompositionEnd(() => {
    composing = false;
    if (quick) editor.updateOptions({ quickSuggestions: quick });
    quick = undefined;
    const state = current(editor);
    if (state) suggestAt(state.model, state.offset, () => true);
  }));

  async function fields(insert: boolean) {
    const state = current(editor);
    if (!state) return;
    const scope = sqlScopeAt(state.analysis, state.offset);
    let source = sourceAt(state), wildcard: SqlWildcard | undefined, qualifier: string | undefined;
    if (!insert) {
      // 判定与表名旁的 chip 共用同一份：否则会出现「chip 显示、点了却提示请把光标放在 * 上」。
      // 先认光标压着的 `*`，再认语句里唯一的那个：补全列表的「展开 *」可以从任意位置
      // 触发（打 `exp` 搜出来时词条已被吃掉、光标并不在 `*` 上），两处必须同判据。
      wildcard = sqlWildcardAt(state.analysis, state.offset) ?? sqlWildcardInScope(state.analysis, state.offset);
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
    const names = sqlFieldIdentifiers(cols, state.dialect);
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
  /**
   * 保存为 SQL 片段：有选区存选区，无选区存光标所在语句。
   * 不弹命名框——「随手存一条」多一步对话框就没人存了；名字由 SQL 首行兜底，
   * 不满意去片段抽屉改名（那里也能改作用域）。
   */
  function saveSnippet() {
    const state = current(editor);
    if (!state) return;
    const selection = editor.getSelection();
    const picked = selection && !selection.isEmpty() ? state.model.getValueInRange(selection) : (splitStatements(state.sql).find(s => s.start <= state.offset && s.end >= state.offset)?.text ?? "");
    const sql = picked.trim();
    if (!sql) { toast("没有可保存的 SQL：选中一段，或把光标放进一条语句里", "info"); return; }
    const saved = addSnippet({ name: "", sql, connId: state.connId, schema: state.schema });
    toast(`已保存到 SQL 片段：${saved.name}`, "success");
    editor.focus();
  }
  for (const [id, label, run] of [
    ["ncforge.sql.saveSnippet", "保存为 SQL 片段", saveSnippet],
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
    clearTimeout(pendingSuggest);
    if (quick) editor.updateOptions({ quickSuggestions: quick });
    disposables.forEach(d => d.dispose()); accepts.delete(editor); reset();
    quickFixers.delete(editor); actionRunners.delete(editor);
    if (!accepts.size) { acceptCommand?.dispose(); acceptCommand = undefined; }
    if (!quickFixers.size) { quickFixCommand?.dispose(); quickFixCommand = undefined; }
    if (!actionRunners.size) { runActionCommand?.dispose(); runActionCommand = undefined; }
  } };
}
