/**
 * 「主子表联查」的可发现性入口。
 *
 * 那些模板本身只在「新语句开头直接打表名」时才进补全列表（`sqlAssistProvider` 的
 * `bare` 分支）。用户按最常见的 `SELECT * FROM po_...` 写法永远撞不到——他要么先打
 * `SELECT`，要么表名只打了一半。这里补两处，都不动解析逻辑：
 *
 * 1. `billLinkHint`：表名补全项的说明里标一句「N 个关联表 · 支持主子表联查」，
 *    让列表自己说清这张表能展开什么；
 * 2. `wireSqlBillAssist`：光标停在表名上时给一条 CodeAction。
 *
 * 🔴 两种位置两种动作，**不能混**（2026-11-14 修）：
 * - 裸表名（语句还没开始）：把表名替换成整条联查 SQL；
 * - 语句内（`SELECT * FROM po_order`）：只在表名后**追加** `LEFT JOIN ... ON ...`。
 *   这里替换整条语句会毁掉用户已经写好的 SELECT/WHERE。
 *
 * 原先语句内一律不给，于是表名后的 chip 和补全列表里的「补全为整条主子表联查」
 * 都成了死入口——点下去弹一个空菜单。判定与 `sqlAssistActions` 必须同口径。
 *
 * 两处都只认**已读到的**关系：`billLinkHint` 走同步缓存（`peekSqlBusinessMetadata`），
 * 没读到就不说话。说了「支持联查」却点不出东西，比不标更糟。
 */
import { monaco } from "./monacoSetup";
import { connOf, rtOf, sqlColumnEpoch, sqlTabOf } from "./dbStore";
import { connectionKey } from "./dbResultContext";
import { tabIdOfModel } from "./sqlModels";
import { dialectOfSqlModel, sqlAnalysisOf, SQL_LANGUAGE_IDS } from "./monacoSql";
import { peekSqlBusinessMetadata, readSqlBusinessMetadata, type SqlBusinessMetadata } from "./sqlBusiness";
import { plainName as normalized, pureName as pure } from "./sqlBillHint";
import { billJoinSpecs, rankBillRelations, sqlJoinIcon, type BillJoinGroup, type SqlJoinIcon } from "./sqlBillJoin";
import { sqlAssistColumns } from "./sqlAssistColumns";
import { billQueryRelations, billQueryTemplates } from "./sqlBillTemplates";
import { getSqlTemplatesEnabled } from "./sqlTemplates";
import { recordSqlUsage, rollbackSqlUsage, sqlJoinUsageKey, sqlUsageRank, sqlUsageScope, type SqlUsageReceipt } from "./sqlUsage";
import { sqlJoinHistoryRanks } from "./sqlJoinHistory";
import { sqlScopeAt, type SqlSource } from "./sqlScope";
import { sqlName } from "./sqlLex";
import { getSqlFormatPrefs } from "./sqlFormatPrefs";
import { sqlJoinAppendChoices, sqlJoinAppendText, sqlJoinInsertion } from "./sqlJoinAppend";

interface BillTarget { table: string; start: number; end: number; mode: "replace" | "append"; source?: SqlSource }
export interface SqlJoinPresentation {
  group: BillJoinGroup; table: string; label: string; sql: string; mode: BillTarget["mode"];
  rootColumns: readonly string[]; icon: SqlJoinIcon;
  usageKey?: string; usageRank?: number; relationSource?: string; mayRepeatRows?: boolean;
}
export type SqlActionPreview = import("./sqlAssistPreview").SqlAssistPreview;
interface JoinOptions { actions: SqlCodeAction[]; added: SqlJoinPresentation[] }
export interface SqlJoinBatch {
  source: number;
  sources: readonly { id: number; label: string }[];
  clause?: string;
  added: SqlJoinPresentation[];
  current: () => boolean;
  read: (id: number) => Promise<JoinOptions>;
  preview: (items: readonly SqlJoinPresentation[]) => string;
  apply: (id: number, items: readonly SqlJoinPresentation[]) => boolean;
}
export type SqlCodeAction = monaco.languages.CodeAction & {
  ncforgeJoin?: SqlJoinPresentation; ncforgeJoinBatch?: SqlJoinBatch; ncforgePreview?: SqlActionPreview; ncforgeApply?: () => boolean;
};
interface BillAction { title: string; range: { start: number; end: number }; preview: Omit<SqlJoinPresentation, "icon"> }

type Editor = monaco.editor.IStandaloneCodeEditor;
type JoinInsertion = NonNullable<ReturnType<typeof sqlJoinInsertion>>;
const continuations = new WeakMap<Editor, { model: monaco.editor.ITextModel; version: number; offset: number; origin: number; current: () => boolean }>();
const joinEdits = new WeakMap<monaco.editor.ITextModel, Map<number, { before: number; receipts: SqlUsageReceipt[] }>>();

function rememberJoinEdit(model: monaco.editor.ITextModel, before: number, scope: string, keys: readonly string[]) {
  const receipts = [...new Set(keys)].map(key => recordSqlUsage(scope, key, "accept")).filter(receipt => receipt !== null);
  if (!receipts.length) return;
  const after = model.getAlternativeVersionId();
  let edits = joinEdits.get(model);
  if (!edits) {
    const tracked = new Map<number, { before: number; receipts: SqlUsageReceipt[] }>();
    let previous = after;
    model.onDidChangeContent(event => {
      const next = model.getAlternativeVersionId(), edit = tracked.get(previous);
      if (event.isUndoing && edit?.before === next) {
        edit.receipts.forEach(rollbackSqlUsage);
        tracked.delete(previous);
      }
      previous = next;
    });
    joinEdits.set(model, edits = tracked);
  }
  // Monaco restores alternative versions on undo, even if other edits were undone first.
  edits.set(after, { before, receipts });
  if (edits.size > 128) edits.delete(edits.keys().next().value!);
}

export function sqlJoinContinuationAt(editor: Editor, offset?: number) {
  const entry = continuations.get(editor);
  if (!entry || !entry.current() || entry.model !== editor.getModel() || entry.version !== entry.model.getVersionId()) return;
  const caret = offset === undefined ? editor.getPosition() : null;
  if (entry.offset === (offset ?? (caret && entry.model.getOffsetAt(caret)))) return entry;
}

export function applySqlJoinAppend(editor: Editor, model: monaco.editor.ITextModel, insertion: JoinInsertion,
  origin: number, joins: readonly string[], current: () => boolean, identityCurrent: () => boolean,
  usage: { scope: string; keys: readonly string[] }) {
  if (!joins.length || editor.getModel() !== model || !current()) return false;
  const { text, block } = sqlJoinAppendText(insertion, joins), eol = model.getEOL();
  const at = model.getPositionAt(insertion.end);
  const before = model.getAlternativeVersionId();
  editor.pushUndoStop();
  if (!editor.executeEdits("ncforge.sql.appendJoins", [{ range: monaco.Range.fromPositions(at, at), text: text.replace(/\n/g, eol) }])) return false;
  editor.pushUndoStop();
  rememberJoinEdit(model, before, usage.scope, usage.keys);
  // The original source declaration stays before the insert, even when continuing from a joined alias.
  const offset = insertion.end + block.replace(/\n/g, eol).length;
  continuations.set(editor, { model, version: model.getVersionId(), offset, origin, current: identityCurrent });
  const caret = model.getPositionAt(offset);
  editor.setPosition(caret);
  editor.revealPosition(caret);
  editor.focus();
  return true;
}

/**
 * 光标所在的**表名**。
 *
 * - 语句还没开始（`!sqlScopeAt`）：裸表名，替换安全；
 * - 语句内：只认**表的声明**（`FROM`/`JOIN` 后面那个词）。别名、字段、CTE 上
 *   追加 JOIN 会拼出一句读不懂的 SQL，宁可什么都不给。
 */
function targetAt(model: monaco.editor.ITextModel, offset: number): BillTarget | undefined {
  const analysis = sqlAnalysisOf(model);
  let index = analysis.tokens.findIndex(t => ["identifier", "quoted"].includes(t.kind) && t.start <= offset && t.end >= offset);
  if (index < 0) {
    // 光标停在表名后面（含多打的一个空格）也要认：补全列表里的动作项是按「光标前的词」
    // 判出来的，这里不跟上就会出现「列表给了动作、点下去是空菜单」。
    const before = analysis.tokens.filter(t => t.end <= offset && !["space", "comment", "hint"].includes(t.kind)).pop();
    if (!before || !["identifier", "quoted"].includes(before.kind) || offset - before.end > 1) return undefined;
    index = analysis.tokens.indexOf(before);
  }
  const token = analysis.tokens[index];
  const table = normalized(sqlName(token));
  if (!pure(table)) return undefined;
  const hit = { table, start: token.start, end: token.end };
  const scope = sqlScopeAt(analysis, offset);
  if (!scope) return { ...hit, mode: "replace" };
  if (scope.select !== undefined && analysis.tokens[scope.select]?.text.toUpperCase() !== "SELECT") return;
  const source = scope.sources?.find(s => s.declaration === index);
  if (!source?.table || source.quoted) return;
  return { ...hit, mode: "append", source };
}

/** CodeAction 每次移光标都会被问一遍，算好的 SQL 缓存一小会儿，避免反复读列。 */
const ACTION_TTL = 60_000;
const actionCache = new Map<string, { at: number; actions: BillAction[] }>();

async function billActions(connId: string, table: string, available: readonly string[], names: Readonly<Record<string, string>>,
  meta: SqlBusinessMetadata, current: () => boolean): Promise<BillAction[]> {
  const relations = rankBillRelations(table, billQueryRelations(table, available, meta), names).slice(0, 8);
  if (!relations.length) return [];
  const root = await sqlAssistColumns(connId, table, current, true).catch(() => []);
  if (!root.length || !current()) return [];
  const others = [...new Set(relations.map(r => r.relation.table))].slice(0, 3);
  const related = await Promise.all(others.map(async other =>
    [other, await sqlAssistColumns(connId, other, current).catch(() => [])] as const));
  if (!current()) return [];
  const columns = { [table]: root, ...Object.fromEntries(related) }, upper = getSqlFormatPrefs().keywordCase !== "lower";
  return relations.flatMap(({ relation, group }) => {
    // `billQueryTemplates` 要求主表有 `vbillcode`，没有就返回空——那种表生成不出
    // 可执行的 SQL，宁可不给，也不塞一条要用户自己补条件的半成品。
    const tpl = billQueryTemplates(table, names, columns, [relation], upper, "plsql")[0];
    if (!tpl) return [];
    return [{
      title: `生成主子表联查：${names[table] || table} + ${names[relation.table] || relation.table}`,
      preview: { group, table: relation.table, label: names[relation.table] || relation.table, sql: tpl.sql, mode: "replace", rootColumns: relation.rootColumns },
      range: { start: -1, end: -1 },
    }];
  });
}

export function wireSqlBillAssist(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
  let disposed = false;
  const disposables: { dispose: () => void }[] = [];
  for (const language of SQL_LANGUAGE_IDS) disposables.push(monaco.languages.registerCodeActionProvider(language, {
    async provideCodeActions(model, range, _context, token) {
      if (disposed || model !== editor.getModel() || model.isDisposed() || token.isCancellationRequested) return { actions: [], dispose() {} };
      if (!getSqlTemplatesEnabled() || dialectOfSqlModel(model) !== "plsql") return { actions: [], dispose() {} };
      const tabId = tabIdOfModel(model), connId = sqlTabOf(tabId)?.connId, rt = connId ? rtOf(connId) : null;
      if (!connId || !rt || rt.status !== "connected") return { actions: [], dispose() {} };
      const offset = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
      const continuation = sqlJoinContinuationAt(editor, offset);
      const origin = continuation?.origin ?? offset;
      const target = targetAt(model, origin);
      if (!target) return { actions: [], dispose() {} };
      const schema = rt.currentSchema ?? rt.info?.schema ?? "";
      const version = model.getVersionId(), epoch = sqlColumnEpoch(connId), identity = connectionKey(connOf(connId));
      const identityCurrent = () => {
        const runtime = rtOf(connId);
        return !disposed && getSqlTemplatesEnabled() && !model.isDisposed() && editor.getModel() === model
          && sqlTabOf(tabId)?.connId === connId && runtime.status === "connected" && sqlColumnEpoch(connId) === epoch
          && connectionKey(connOf(connId)) === identity && (runtime.currentSchema ?? runtime.info?.schema ?? "") === schema;
      };
      const current = () => identityCurrent() && model.getVersionId() === version;
      const alive = () => !token.isCancellationRequested && current();
      const scopeKey = sqlUsageScope(identity, schema);
      const views = new Set<string>();
      const available = (rt.tables ?? []).map(table => {
        if (table.kind === "VIEW") views.add(normalized(table.name));
        return table.name;
      });
      const names = rt.ncNames ?? {};
      const readMeta = (table: string, valid: () => boolean) => peekSqlBusinessMetadata(connId, scopeKey, table)
        ?? readSqlBusinessMetadata(connId, scopeKey, table, valid).catch(() => null);
      if (target.mode === "append") {
        const analysis = sqlAnalysisOf(model), scope = sqlScopeAt(analysis, origin);
        const insertion = scope && sqlJoinInsertion(analysis, scope, model.getValue());
        if (!scope || !insertion || !target.source) return { actions: [], dispose() {} };
        const fromTables = new Set(available.map(normalized));
        const lastComma = Math.max(-1, ...insertion.chain.filter(t => t.text === ",").map(t => t.start));
        const sources = scope.sources.filter(source => source.table && !source.quoted && fromTables.has(normalized(source.table))
          && (!source.schema || source.schema.toLowerCase() === schema.toLowerCase()) && analysis.tokens[source.declaration].start > lastComma);
        const sourceId = target.source.declaration;
        if (!sources.some(source => source.declaration === sourceId)) return { actions: [], dispose() {} };
        const at = model.getPositionAt(insertion.end), range = monaco.Range.fromPositions(at, at);
        const preview = (items: readonly SqlJoinPresentation[]) => sqlJoinAppendText(insertion, items.map(item => item.sql)).preview;
        const read = async (id: number, valid = current): Promise<JoinOptions> => {
          const source = sources.find(candidate => candidate.declaration === id);
          if (!source?.table || !valid()) return { actions: [], added: [] };
          const table = normalized(source.table), meta = await readMeta(table, valid);
          if (!valid() || !meta || meta.sharedSession || meta.schema && meta.schema.toLowerCase() !== schema.toLowerCase()) return { actions: [], added: [] };
          const specs = billJoinSpecs(table, available, meta, names);
          const history = sqlJoinHistoryRanks(scopeKey, table);
          const actions: SqlCodeAction[] = [], added: SqlJoinPresentation[] = [];
          for (const { spec, added: exists, sql } of sqlJoinAppendChoices(analysis, scope, insertion, source, schema, specs)) {
            const { table, group, rootColumns } = spec;
            const label = names[table] || table;
            const usageKey = sqlJoinUsageKey(source.table, table, rootColumns, spec.otherColumns);
            const item: SqlJoinPresentation = { table, group, rootColumns, sql, label, mode: "append", icon: sqlJoinIcon(table, group, views.has(table)),
              relationSource: spec.source, mayRepeatRows: spec.incoming,
              usageKey, usageRank: sqlUsageRank(scopeKey, usageKey) || history.get(usageKey) || 0 };
            if (exists) added.push(item);
            else actions.push({ title: `追加 LEFT JOIN：${label}`, kind: "refactor.rewrite", ncforgeJoin: item,
              ncforgePreview: { text: preview([item]), current }, edit: { edits: [{ resource: model.uri, versionId: version,
                textEdit: { range, text: sqlJoinAppendText(insertion, [sql]).text } }] } });
          }
          return { actions, added };
        };
        const initial = await read(sourceId, alive);
        if (!alive() || !initial.actions.length && !initial.added.length && sources.length < 2 && !continuation) return { actions: [], dispose() {} };
        const batch: SqlJoinBatch = {
          source: sourceId, sources: sources.map(source => ({ id: source.declaration,
            label: [source.tableRef ?? source.table, source.aliasRef].filter(Boolean).join(" ") })),
          clause: insertion.clause, added: initial.added, current, read, preview,
          apply: (id, items) => {
            const source = sources.find(candidate => candidate.declaration === id);
            return !!source && applySqlJoinAppend(editor, model, insertion, analysis.tokens[source.declaration].start,
              items.map(item => item.sql), current, identityCurrent,
              { scope: scopeKey, keys: items.flatMap(item => item.usageKey ? [item.usageKey] : []) });
          },
        };
        const actions = initial.actions.length ? initial.actions : [{ title: "主子表联查", kind: "refactor.rewrite" }];
        return { actions: actions.map(action => ({ ...action, ncforgeJoinBatch: batch })), dispose() {} };
      }
      // Cache the whole-query templates by connection and column epoch. Append edits are scoped to the current SQL.
      const cacheKey = `${connId}|${target.table}|${schema}|${epoch}|${identity}`;
      const cached = actionCache.get(cacheKey);
      const ready = cached && Date.now() - cached.at < (cached.actions.length ? ACTION_TTL : 10_000) ? cached.actions : undefined;
      const actions = ready ?? await (async () => {
        const meta = await readMeta(target.table, alive);
        if (!alive() || !meta || meta.sharedSession) return [];
        const built = await billActions(connId, target.table, available, names, meta, alive);
        if (alive()) actionCache.set(cacheKey, { at: Date.now(), actions: built });
        if (actionCache.size > 64) actionCache.delete(actionCache.keys().next().value!);
        return built;
      })();
      if (!alive() || !actions.length) return { actions: [], dispose() {} };
      return {
        actions: actions.map((action): SqlCodeAction => ({
          title: action.title, kind: "refactor.rewrite",
          ncforgePreview: { text: action.preview.sql.trim(), current },
          ncforgeJoin: {
            ...action.preview,
            icon: sqlJoinIcon(action.preview.table, action.preview.group, views.has(action.preview.table)),
          },
          edit: { edits: [{
            resource: model.uri, versionId: version,
            textEdit: {
              // 整条替换用表名本身的范围；追加用表名末尾的空范围（光标停在词中间也不会切坏标识符）。
              range: monaco.Range.fromPositions(
                model.getPositionAt(action.range.start < 0 ? target.start : action.range.start),
                model.getPositionAt(action.range.end < 0 ? target.end : action.range.end)),
              text: action.preview.sql,
            },
          }] },
        })),
        dispose() {},
      };
    },
  }, { providedCodeActionKinds: ["refactor.rewrite"] }));
  return { dispose() { if (disposed) return; disposed = true; disposables.forEach(d => d.dispose()); } };
}

/** 连接或 schema 变了之后，缓存里的 SQL 可能指向另一套元数据。 */
export function clearBillActionCache(): void { actionCache.clear(); }
