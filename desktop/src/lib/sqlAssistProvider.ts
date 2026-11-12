import { monaco } from "./monacoSetup";
import { connOf, rtOf, sqlColumnEpoch, sqlTabOf } from "./dbStore";
import { sqlAssistColumns as readAssistColumns } from "./sqlAssistColumns";
import { connectionKey } from "./dbResultContext";
import { tabIdOfModel } from "./sqlModels";
import { dialectOfSqlModel, sqlAnalysisOf } from "./monacoSql";
import { resolveSqlQualifier, sqlCtesAt, sqlScopeAt, sqlSourcesAt, type SqlSource } from "./sqlScope";
import { getSqlFormatPrefs } from "./sqlFormatPrefs";
import { getSqlTemplatesEnabled, tableTemplates } from "./sqlTemplates";
import { completionContext, sqlIdentifier } from "./sqlCompletionContext";
import { sqlAssistSort, sqlMatchQuality, sqlSnippetText } from "./sqlAssistRanking";
import { sqlAssistFunctions, sqlAssistKeywords } from "./sqlAssistDialect";
import { sqlUsageKey, sqlUsageReason, sqlUsageScope } from "./sqlUsage";
import { filterSnippets, listSnippets } from "./dbSnippets";
import { clearSqlBusinessCache, readSqlBusinessMetadata, sqlConditionSuggestions, sqlEnumSuggestions, sqlJoinSuggestions, type BusinessSuggestion } from "./sqlBusiness";
import { sqlHistoricalJoinSuggestions } from "./sqlJoinHistory";
import type { ColumnInfo } from "./dbApi";
import { sqlReferenceKey, sqlWordKind } from "./sqlLex";

type Item = monaco.languages.CompletionItem;
const K = monaco.languages.CompletionItemKind;
const fieldCache = new Map<string, { columns: ColumnInfo[]; at: number }>();
const scopesSeen = new Map<string, string>();
const mixed = (name: string) => /[a-z]/.test(name) && /[A-Z]/.test(name);
const normalized = (name: string) => mixed(name) ? name : name.toLowerCase();
async function early<T>(promise: Promise<T>, fallback: T, budget = 120): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const value = await Promise.race([promise, new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), budget); })]);
  clearTimeout(timer);
  return value;
}

/** A snapshot is returned once. Learning and late metadata never reorder an already selected list. */
export async function provideSqlAssist(model: monaco.editor.ITextModel, position: monaco.Position, context: monaco.languages.CompletionContext, token: monaco.CancellationToken): Promise<monaco.languages.CompletionList> {
  const tabId = tabIdOfModel(model), connId = sqlTabOf(tabId)?.connId;
  const rt = connId ? rtOf(connId) : null, identity = connectionKey(connId ? connOf(connId) : null);
  const schema = rt?.currentSchema ?? rt?.info?.schema ?? "", scope = connId ? sqlUsageScope(identity, schema) : null;
  const epoch = connId ? sqlColumnEpoch(connId) : 0;
  const version = model.getVersionId(), dialect = dialectOfSqlModel(model), analysis = sqlAnalysisOf(model), offset = model.getOffsetAt(position);
  const ctx = completionContext(analysis, offset, dialect);
  const word = model.getWordUntilPosition(position);
  const identifier = analysis.tokens.find(t => t.start < offset && t.end >= offset && ["identifier", "quoted"].includes(t.kind));
  const start = identifier?.start ?? offset - (position.column - word.startColumn);
  const prefix = model.getValue().slice(ctx.valueStart ?? start, offset).replace(/^['"`[]/, "");
  const range = monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(identifier?.end ?? offset));
  const waitBudget = context?.triggerKind === monaco.languages.CompletionTriggerKind.Invoke ? 500 : 120;
  const loadingItem: Item = {
    label: { label: "字段加载中", description: "稍后按 Ctrl+空格刷新" },
    kind: K.Text, insertText: "", filterText: prefix || "字段加载中", sortText: "z",
    range: monaco.Range.fromPositions(position, position),
  };
  if (connId && scope) {
    if (scopesSeen.has(connId) && scopesSeen.get(connId) !== scope) clearSqlBusinessCache();
    scopesSeen.set(connId, scope);
    if (scopesSeen.size > 64) scopesSeen.delete(scopesSeen.keys().next().value!);
  }
  const stale = () => token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version || sqlTabOf(tabId)?.connId !== connId
    || !metadataCurrent();
  const metadataCurrent = () => !connId || (sqlColumnEpoch(connId) === epoch && (rtOf(connId).currentSchema ?? rtOf(connId).info?.schema ?? "") === schema && connectionKey(connOf(connId)) === identity);
  const match = (name: string, zh = "") => sqlMatchQuality(prefix, name, zh);
  const filter = (name: string) => prefix || name;
  const objectKey = (source: SqlSource) => source.schema && source.schema.toLowerCase() !== schema.toLowerCase() ? source.tableRef! : source.table!;
  const command = (key: string) => scope ? { id: "ncforge.sql.accept", title: "记录补全选择", arguments: [{ scope, key }] } : undefined;
  const reason = (key: string) => scope ? sqlUsageReason(scope, key) : "";
  const cachedKey = (source: SqlSource) => JSON.stringify([connId, scope, epoch, rt?.tablesAt, source.tableRef ?? source.table]);
  const readColumns = async (source: SqlSource): Promise<ColumnInfo[]> => {
    if (!connId || !source.table || source.quoted || stale()) return [];
    const key = cachedKey(source), cached = fieldCache.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.columns;
    try {
      if (rt?.status !== "connected" && source.schema && source.schema.toLowerCase() !== schema.toLowerCase()) return [];
      const cols = rt?.status === "connected" ? await readAssistColumns(connId, source.tableRef ?? source.table, () => !stale(), ctx.kind === "column") : (rt?.schema?.tables[source.table] ?? []).map(([name, full]) => ({ name, full, zh: null, pk: false } as ColumnInfo));
      if (stale()) return [];
      fieldCache.set(key, { columns: cols, at: Date.now() });
      if (fieldCache.size > 256) fieldCache.delete(fieldCache.keys().next().value!);
      return cols;
    } catch { return []; }
  };
  const ctes = sqlCtesAt(analysis, offset), sources = sqlSourcesAt(analysis, offset);
  const sourceKey = (s: SqlSource) => sqlReferenceKey(s.alias ?? s.name, s.aliasRef ?? s.nameRef, dialect);
  const unique = (s: SqlSource) => sources.filter(other => sourceKey(other) === sourceKey(s)).length === 1;
  const visible = sources.filter(unique);
  const qualifierText = (s: SqlSource) => s.aliasRef ?? (s.alias ? sqlIdentifier(s.alias, dialect) : s.nameRef ?? sqlIdentifier(s.name, dialect));
  // 光标不落在任何查询语句里 = 语句还没开始（空行、或刚敲完分号的新语句）。
  // 这是「先打表名、再补 select」的起点，也是唯一该把表名与整条查询模板端出来的位置；
  // 一旦进了 SELECT 投影 / WHERE，列表要留给字段。
  // 🔴 判据不能用 `analysis.scopes.length === 0`：脚本里前面写过语句就永远不为 0。
  const bare = !sqlScopeAt(analysis, offset);
  const tableList = rt?.tables ?? Object.keys(rt?.schema?.tables ?? {}).map(name => ({ name, kind: "TABLE" }));
  const tables = (): Item[] => {
    if (!connId || ctx.kind === "schema" && ctx.schema?.toLowerCase() !== schema.toLowerCase()) return [];
    const shadowed = new Set(ctes.map(c => sqlReferenceKey(c.name, c.nameRef, dialect)));
    return tableList.flatMap(t => {
      const name = normalized(t.name), zh = rt?.ncNames?.[name.toLowerCase()] ?? "", quality = match(name, zh);
      if (quality === 9) return [];
      const insertText = sqlIdentifier(sqlWordKind(name, dialect) === "identifier" ? name : t.name, dialect);
      if (shadowed.has(sqlReferenceKey(name, insertText, dialect))) return [];
      const key = sqlUsageKey(insertText), why = reason(key);
      return [{ label: { label: name, description: [zh || (t.kind === "VIEW" ? "视图" : ""), why].filter(Boolean).join(" · ") }, kind: t.kind === "VIEW" ? K.Interface : K.Struct,
        insertText, filterText: filter(name), range, sortText: sqlAssistSort(quality, 4, name, scope, key), command: command(key),
        documentation: { value: `${schema ? schema + "." : ""}${name}${zh ? "\n\n" + zh : ""}${why ? "\n\n推荐依据：" + why : ""}` } }];
    });
  };
  const cteItems: Item[] = ctes.filter(c => match(c.name) < 9).map(c => ({ label: { label: c.name, description: "当前查询 CTE" }, kind: K.Interface, insertText: c.nameRef ?? sqlIdentifier(c.name, dialect), filterText: filter(c.name), range, sortText: sqlAssistSort(match(c.name), 0, c.name) }));
  /**
   * 唯一命中（或精确命中）的那张表，额外给「整条查询」模板。
   *
   * 排序：复用表名的 sortText 再追加 `~序号`。表名本身的 sortText 止于 name，是它的
   * 前缀，所以表名永远排在模板前面——配合 `suggestSelection: "first"`（见
   * `sqlEditorAssist`），回车默认仍然只插入表名，不会误插一整条语句。
   */
  const templates = (): Item[] => {
    if (!connId || !prefix || !getSqlTemplatesEnabled()) return [];
    const typed = prefix.toLowerCase();
    const named = tableList.map(t => ({ raw: t.name, name: normalized(t.name) }));
    const exact = named.filter(t => t.name.toLowerCase() === typed);
    const candidates = exact.length ? exact : named.filter(t => t.name.startsWith(typed));
    // 多条命中就不猜：猜错一次就要用户撤销一整条语句
    if (candidates.length !== 1) return [];
    const { raw, name } = candidates[0];
    const insertText = sqlIdentifier(sqlWordKind(name, dialect) === "identifier" ? name : raw, dialect);
    const head = sqlAssistSort(match(name), 4, name);
    const upper = getSqlFormatPrefs().keywordCase !== "lower";
    return tableTemplates(insertText, upper, dialect).map((tpl, i) => ({
      label: { label: tpl.label, description: tpl.hint }, kind: K.Snippet, insertText: tpl.insertText,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      filterText: name, range, sortText: `${head}~${i}`,
      documentation: { value: `\`\`\`sql\n${tpl.label};\n\`\`\`` },
    }));
  };
  if (ctx.kind === "none" || stale()) return { suggestions: [] };
  if (ctx.kind === "table" || ctx.kind === "schema") return { suggestions: [...cteItems.filter(() => ctx.kind !== "schema"), ...tables()], incomplete: true };
  const fromColumns = (source: SqlSource, cols: ColumnInfo[], qualified: boolean): Item[] => cols.flatMap(c => {
    const name = normalized(c.name), quality = match(name, c.zh ?? "");
    if (quality === 9) return [];
    const q = qualifierText(source), insertText = `${qualified ? q + "." : ""}${sqlIdentifier(sqlWordKind(name, dialect) === "identifier" ? name : c.name, dialect)}`;
    const key = source.table ? sqlUsageKey(objectKey(source), name, ctx.clause) : undefined, why = key ? reason(key) : "";
    return [{ label: { label: qualified ? `${source.alias ?? source.name}.${name}` : name, detail: ` ${c.full}${c.pk ? " · PK" : ""}`, description: [c.zh || source.tableRef || source.name, why].filter(Boolean).join(" · ") }, kind: c.pk ? K.Property : K.Field,
      insertText, filterText: filter(name), range, sortText: sqlAssistSort(quality, 1, insertText, scope, key, ctx.assigned.includes(name)), command: key ? command(key) : undefined,
      documentation: { value: `${source.tableRef ?? source.name}.${name}\n\n${c.full}${c.zh ? " · " + c.zh : ""}${why ? "\n\n" + why : ""}` } }];
  });
  const derived = (source: SqlSource, qualified: boolean): Item[] => (source.columns ?? []).filter(name => match(name) < 9).map(name => ({ label: { label: qualified ? `${source.alias ?? source.name}.${name}` : name, description: "查询输出 · " + (source.alias ?? source.name) }, kind: K.Field,
    insertText: `${qualified ? qualifierText(source) + "." : ""}${sqlIdentifier(name, dialect)}`, filterText: filter(name), range, sortText: sqlAssistSort(match(name), 1, name) }));
  if (ctx.kind === "column") {
    const source = resolveSqlQualifier(analysis, offset, ctx.qualifier!, ctx.qualifierRef);
    const columns = source?.table ? await early(readColumns(source), null, waitBudget) : undefined;
    const suggestions = !source ? [] : columns === null ? [loadingItem] : columns ? fromColumns(source, columns, false) : derived(source, false);
    return { suggestions: stale() ? [] : suggestions, incomplete: true };
  }
  const businessItem = (s: BusinessSuggestion, targetRange = range): Item => ({ label: { label: s.label, detail: ctx.clause === "on" && ctx.kind !== "value" ? `  ${s.insertText}` : undefined, description: s.reason }, kind: K.Snippet, insertText: s.insertText, range: targetRange,
    insertTextRules: s.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    filterText: filter(s.label), sortText: `${match(s.label, s.insertText)}00${s.label}`, documentation: { value: s.documentation + "\n\n来源：" + s.source } });
  const physical = visible.filter(s => s.table && !s.quoted && (!s.schema || s.schema.toLowerCase() === schema.toLowerCase()));
  const metadata = async (source: SqlSource) => {
    if (!connId || !scope || !physical.includes(source) || rt?.status !== "connected") return null;
    return early(readSqlBusinessMetadata(connId, scope, source.table!, metadataCurrent), null);
  };
  if (ctx.kind === "value") {
    const source = ctx.valueSource!, cols = await early(readColumns(source), null, waitBudget), column = cols?.find(c => c.name.toLowerCase() === ctx.field?.toLowerCase());
    if (!cols) return { suggestions: stale() ? [] : [loadingItem], incomplete: true };
    const meta = column && await metadata(source);
    const suggestions = meta && column ? sqlEnumSuggestions(meta, ctx.field!, column.full).filter(s => !prefix || match(s.label, s.insertText) < 9).map(s => businessItem(s, monaco.Range.fromPositions(model.getPositionAt(ctx.valueStart!), model.getPositionAt(ctx.valueEnd!)))) : [];
    return { suggestions: stale() ? [] : suggestions, incomplete: true };
  }
  const loaded = new Map<SqlSource, ColumnInfo[]>();
  // Two reads at a time, with an early snapshot for a cold query. Aliases keep every source discoverable.
  let next = 0;
  const budget = visible.slice(0, 32);
  const load = async () => { while (next < budget.length && !stale()) { const source = budget[next++]; if (source.table) loaded.set(source, await readColumns(source)); } };
  const fieldsReady = await early(Promise.all([load(), load()]).then(() => true), false, waitBudget);
  if (stale()) return { suggestions: [] };
  const cols = visible.flatMap(s => s.table ? fromColumns(s, loaded.get(s) ?? [], sources.length > 1) : derived(s, sources.length > 1));
  const aliases: Item[] = visible.filter(s => match(s.alias ?? s.name) < 9).map(s => ({ label: { label: s.alias ?? s.name, description: `来源 ${s.tableRef ?? "查询输出"} · 输入 . 查看字段` }, kind: K.Variable, insertText: qualifierText(s), filterText: filter(s.alias ?? s.name), range, sortText: sqlAssistSort(match(s.alias ?? s.name), 3, s.name) }));
  const functions: Item[] = sqlAssistFunctions(dialect).filter(f => match(f.name) < 9 && !["set", "order", "group"].includes(ctx.clause)).map(f => ({ label: { label: f.name, detail: `(${f.args.join(", ")})`, description: f.description }, kind: K.Function,
    insertText: `${f.name}(${f.args.map((arg, i) => `\${${i + 1}:${arg}}`).join(", ")})`, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, filterText: filter(f.name), range, sortText: sqlAssistSort(match(f.name), 6, f.name), documentation: f.description }));
  const keywords: Item[] = sqlAssistKeywords(ctx.clause, dialect).filter(k => match(k) < 9).map(k => ({ label: k, kind: K.Keyword, insertText: k, filterText: filter(k), range, sortText: sqlAssistSort(match(k), 7, k) }));
  const snippets: Item[] = prefix ? filterSnippets(listSnippets(connId ?? null), prefix).map(s => ({ label: { label: s.name, description: "已保存 SQL 片段" }, kind: K.Snippet, insertText: sqlSnippetText(s.sql), insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, filterText: filter(s.name), range, sortText: sqlAssistSort(match(s.name, s.sql), 5, s.name), documentation: { value: s.sql } })) : [];
  const projections: Item[] = ctx.projections.filter(name => match(name) < 9).map(name => ({ label: { label: name, description: "当前 SELECT 输出" }, kind: K.Field, insertText: sqlIdentifier(name, dialect), filterText: filter(name), range, sortText: sqlAssistSort(match(name), 0, name) }));
  const business: Item[] = [];
  // Later JOIN tables exist in the parsed query, but are unavailable in this ON condition.
  const onSources = physical.filter(s => analysis.tokens[s.declaration].start < offset);
  if (ctx.clause === "on" && onSources.length > 1) {
    const source = onSources[onSources.length - 1], meta = await metadata(source);
    const verifiedSources = onSources.map(s => ({ ...s, table: s.table! }));
    if (meta) business.push(...sqlJoinSuggestions({ ...meta, schema }, verifiedSources, source.alias ?? source.name, dialect).filter(s => !prefix || match(s.label, s.insertText) < 9).map(s => businessItem(s)));
    if (scope) business.push(...sqlHistoricalJoinSuggestions(scope, verifiedSources, Object.fromEntries(onSources.map(s => [s.tableRef ?? s.table!, (loaded.get(s) ?? []).map(c => ({ name: c.name, type: c.full }))])), dialect).filter(s => !prefix || match(s.label, s.insertText) < 9).map(s => ({ ...businessItem(s), sortText: `${match(s.label, s.insertText)}01${s.label}` })));
  }
  if (ctx.clause === "where") for (const source of physical) business.push(...sqlConditionSuggestions({ ...source, table: source.table! }, (loaded.get(source) ?? []).map(c => ({ name: c.name, type: c.full })), dialect).filter(s => !prefix || match(s.label, s.insertText) < 9).map(s => businessItem(s)));
  // 语句还没开始时，表名才是这个位置最该出现的东西。`any` 分支其余内容（字段、别名、
  // 函数、关键字）在这个位置基本都用不上，所以表名与模板排在最前面。
  // 已知取舍：超过 `SQL_ANALYSIS_LIMIT`（200k 字符）或 512 条语句的脚本里 `analyzeSql`
  // 会放弃建 scope，此时 `bare` 对所有位置都为真——但那时整条链路本来就没有上下文可用，
  // 多出来的表名仍然按输入的前缀过滤，不会误导。
  const tableItems = bare ? tables() : [];
  const templateItems = bare ? templates() : [];
  const suggestions = [...business, ...projections, ...cols, ...aliases, ...tableItems, ...templateItems, ...functions, ...snippets, ...keywords, ...(ctx.clause === "other" ? cteItems : []), ...(fieldsReady ? [] : [loadingItem])];
  return { suggestions: stale() ? [] : suggestions, incomplete: true };
}
