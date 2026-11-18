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
import { billJoinSpecs, rankBillRelations, type BillJoinGroup } from "./sqlBillJoin";
import { sqlAssistColumns } from "./sqlAssistColumns";
import { billQueryRelations, billQueryTemplates } from "./sqlBillTemplates";
import { getSqlTemplatesEnabled } from "./sqlTemplates";
import { sqlUsageScope } from "./sqlUsage";
import { sqlScopeAt, sqlSourcesAt } from "./sqlScope";
import { sqlName } from "./sqlLex";
import { getSqlFormatPrefs } from "./sqlFormatPrefs";

interface BillTarget { table: string; start: number; end: number; mode: "replace" | "append"; qualifier?: string; schema?: string }
export interface SqlJoinPresentation { group: BillJoinGroup; table: string; label: string; sql: string; mode: BillTarget["mode"] }
export type SqlActionPreview = { text: string; description?: boolean } | { read: (current: () => boolean) => Promise<string> };
export type SqlCodeAction = monaco.languages.CodeAction & { ncforgeJoin?: SqlJoinPresentation; ncforgePreview?: SqlActionPreview };
interface BillAction { title: string; range: { start: number; end: number }; preview: SqlJoinPresentation }

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
  const aliasToken = source.aliasRef && analysis.tokens.slice(index + 1)
    .find(t => !["space", "comment", "hint"].includes(t.kind) && t.text.toUpperCase() !== "AS");
  let end = aliasToken ? aliasToken.end : token.end;
  if (scope.sources[0] !== source) {
    // A JOIN attached to an existing joined source must follow its ON clause.
    const stop = scope.indices.find(i => i > index && /^(?:WHERE|GROUP|HAVING|ORDER|CONNECT|START|MODEL|UNION|INTERSECT|MINUS|FETCH|OFFSET|FOR|;)$/i.test(analysis.tokens[i].text));
    const boundary = stop === undefined ? scope.end : analysis.tokens[stop].start;
    // Scope indices skip strings. Count them here so a trailing ON literal stays intact.
    for (let i = index + 1; i < analysis.tokens.length && analysis.tokens[i].start < boundary; i++) {
      const part = analysis.tokens[i];
      if (!["space", "comment", "hint"].includes(part.kind)) end = part.end;
    }
  }
  return { ...hit, end, mode: "append", qualifier: source.aliasRef ?? table, schema: source.schema };
}

/** CodeAction 每次移光标都会被问一遍，算好的 SQL 缓存一小会儿，避免反复读列。 */
const ACTION_TTL = 60_000;
const actionCache = new Map<string, { at: number; actions: BillAction[] }>();

/**
 * 语句内追加：只给「这段 SQL 里还没 JOIN 过」的子表，避免接上第二条同样的 JOIN。
 *
 * 🔴 判据必须是**当前 scope 已解析出的表声明**、按名字精确相等：
 * 拿 `model.getValue().includes(spec.table)` 判会把字符串常量（`where note='po_order_b'`）、
 * 注释、以及**前缀包含**（`po_order_b` vs `po_order_bak`）全误判成「已 JOIN」，
 * 该给的动作凭空消失；而且它判的是整个 model，不是光标所在的那条语句。
 */
function appendActions(target: BillTarget, available: readonly string[], names: Readonly<Record<string, string>>,
  meta: SqlBusinessMetadata, model: monaco.editor.ITextModel, offset: number): BillAction[] {
  // 复用真源 `sqlSourcesAt`（= sqlScopeAt(...)?.sources），别自己再取一遍 scope。
  const sources = sqlSourcesAt(sqlAnalysisOf(model), offset);
  // 表名可能带 schema 前缀（`nc65.po_order_b`），只比最后一段；大小写按 plainName 归一。
  const joined = new Set(sources.flatMap(source => {
    const raw = source.table ?? source.name;
    const table = normalized(raw.slice(raw.lastIndexOf(".") + 1));
    return source.alias ? [table, normalized(source.alias)] : [table];
  }));
  return billJoinSpecs(target.table, available, meta, names, target.qualifier).flatMap((spec) => {
    if (joined.has(normalized(spec.table))) return [];
    const label = names[spec.table] || spec.table;
    return [{ title: `追加 LEFT JOIN：${label}`, preview: { ...spec, label, mode: "append" },
      range: { start: target.end, end: target.end } }];
  });
}

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
      preview: { group, table: relation.table, label: names[relation.table] || relation.table, sql: tpl.sql, mode: "replace" },
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
      const target = targetAt(model, offset);
      if (!target) return { actions: [], dispose() {} };
      const schema = rt.currentSchema ?? rt.info?.schema ?? "";
      if (target.schema && target.schema.toLowerCase() !== schema.toLowerCase()) return { actions: [], dispose() {} };
      const version = model.getVersionId();
      const alive = () => !disposed && !model.isDisposed() && editor.getModel() === model && model.getVersionId() === version && !token.isCancellationRequested;
      // 列元数据版本进 key：重连或刷新表结构后，旧 SQL 里的 JOIN 条件可能已经变了。
      const cacheKey = `${connId}|${target.table}|${target.mode}|${rt.currentSchema ?? ""}|${sqlColumnEpoch(connId)}`;
      const cached = actionCache.get(cacheKey);
      // 空结果只压 10 秒：刚连上库、元数据还没备好时算出空，压满一分钟等于「没反应」。
      const ready = cached && Date.now() - cached.at < (cached.actions.length ? ACTION_TTL : 10_000) ? cached.actions : undefined;
      const scopeKey = sqlUsageScope(connectionKey(connOf(connId)), schema);
      const available = (rt.tables ?? []).map(t => t.name), names = rt.ncNames ?? {};
      const actions = ready ?? await (async () => {
        const meta = peekSqlBusinessMetadata(connId, scopeKey, target.table)
          ?? await readSqlBusinessMetadata(connId, scopeKey, target.table, alive).catch(() => null);
        if (!alive() || !meta || meta.sharedSession) return [];
        // 追加模式的结果取决于「这段 SQL 里已经有哪些表」，不能跨编辑复用缓存。
        if (target.mode === "append") return appendActions(target, available, names, meta, model, offset);
        const built = await billActions(connId, target.table, available, names, meta, alive);
        if (alive()) actionCache.set(cacheKey, { at: Date.now(), actions: built });
        if (actionCache.size > 64) actionCache.delete(actionCache.keys().next().value!);
        return built;
      })();
      if (!alive() || !actions.length) return { actions: [], dispose() {} };
      return {
        actions: actions.map((action): SqlCodeAction => ({
          title: action.title, kind: "refactor.rewrite",
          ncforgeJoin: action.preview,
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
