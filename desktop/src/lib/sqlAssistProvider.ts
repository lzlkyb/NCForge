import { monaco } from "./monacoSetup";
import { connOf, rtOf, sqlColumnEpoch, sqlTabOf } from "./dbStore";
import { sqlAssistColumns as readAssistColumns, sqlFieldIdentifiers } from "./sqlAssistColumns";
import { connectionKey } from "./dbResultContext";
import { tabIdOfModel } from "./sqlModels";
import { dialectOfSqlModel, sqlAnalysisOf } from "./monacoSql";
import { resolveSqlQualifier, sqlCtesAt, sqlScopeAt, sqlSourcesAt, sqlWildcardAt, sqlWildcardInScope, type SqlSource } from "./sqlScope";
import { getSqlFormatPrefs } from "./sqlFormatPrefs";
import { getSqlTemplatesEnabled, querySkeleton, snippetEscape, tableTemplates } from "./sqlTemplates";
import { billQueryRelations, billQueryTemplates, conditionQueryTemplates, completeQueryTemplates } from "./sqlBillTemplates";
import { sqlTableDescription } from "./sqlBillHint";
import { billJoinGroupLabels, billJoinSpecs, rankBillRelations, sqlJoinIcon } from "./sqlBillJoin";
import { applySqlJoinAppend } from "./sqlBillAssist";
import { sqlJoinAppendChoices, sqlJoinAppendText, sqlJoinInsertion } from "./sqlJoinAppend";
import { sqlActionsAt, keywordFor, ACTION_COMMANDS } from "./sqlAssistActions";
import { isPlsql, splitStatements } from "./sqlSplit";
import { sqlPredicateContext } from "./sqlPredicateContext";
import { sqlPredicates } from "./sqlPredicates";
import { sqlTimePresets } from "./sqlTimePresets";
import { sqlAssistPickerChoices } from "./sqlAssistPicker";
import { buildBillRelationChecks, buildIncomingDetailCountChecks } from "./sqlQueryChecks";
import { archiveExpansion, archiveProjectionAt, archiveRelations } from "./sqlArchiveExpansion";
import { completionContext, sqlIdentifier } from "./sqlCompletionContext";
import { sqlAssistSort, sqlMatchQuality, sqlSnippetText } from "./sqlAssistRanking";
import { sqlAssistFunctionsFor, sqlAssistKeywords } from "./sqlAssistDialect";
import { sqlUsageKey, sqlUsageReason, sqlUsageScope } from "./sqlUsage";
import { filterSnippets, listSnippets } from "./dbSnippets";
import { clearSqlBusinessCache, peekSqlBusinessMetadata, readSqlBusinessMetadata, sqlConditionSuggestions, sqlEnumSuggestions, sqlJoinSuggestions, sqlRelatedQueries, type BusinessSuggestion } from "./sqlBusiness";
import { sqlHistoricalJoinSuggestions } from "./sqlJoinHistory";
import type { ColumnInfo } from "./dbApi";
import { sqlReferenceKey, sqlWordKind } from "./sqlLex";
import { sqlExplicit, type SqlCompletionItem } from "./sqlExplicitCompletion";
import { sqlPreviewEdits, sqlPreviewSnippet } from "./sqlPreviewCode";
import { verifiedSqlSource } from "./sqlAssistLearning";
import { recordAssistCall, recordAssistEarly, recordAssistOffers } from "./sqlAssistStats";
import { rankedDbFavorites } from "./dbObjectRanking";
import { favoriteKey } from "./dbFavorites";

type Item = SqlCompletionItem;
const K = monaco.languages.CompletionItemKind;
const fieldCache = new Map<string, { columns: ColumnInfo[]; at: number }>();
const scopesSeen = new Map<string, string>();
const mixed = (name: string) => /[a-z]/.test(name) && /[A-Z]/.test(name);
const normalized = (name: string) => mixed(name) ? name : name.toLowerCase();
const tableCatalogCache = new WeakMap<readonly object[], ReturnType<typeof buildTableCatalog>>();
function buildTableCatalog(list: readonly { name: string; kind: string }[], names: Readonly<Record<string, string>> | undefined) {
  const entries = list.map(table => ({
    ...table, normalized: normalized(table.name), zh: names?.[table.name.toLowerCase()] ?? "",
  }));
  const exact = new Set(entries.map(table => table.normalized));
  const chinese = new Map<string, string>();
  for (const table of entries) if (table.zh && !chinese.has(table.zh.toLowerCase())) chinese.set(table.zh.toLowerCase(), table.normalized);
  return { entries, tableNames: entries.map(table => table.name), exact, chinese, names };
}
async function early<T>(promise: Promise<T>, fallback: T, budget = 120): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const value = await Promise.race([promise, new Promise<T>(resolve => { timer = setTimeout(() => { timedOut = true; resolve(fallback); }, budget); })]);
  clearTimeout(timer);
  recordAssistEarly(budget, timedOut);
  return value;
}

/**
 * 给补全项打建议源标签（质量统计用）。没有 command 的条目挂一条只记统计的
 * command——Monaco 0.52 没有接受事件，command 是唯一可靠的接受信号。
 * 已有 command 的条目（选字段、唤起菜单、使用记忆）不覆盖：它们只计曝光。
 */
const mark = (source: string, item: Item): Item => {
  item.ncforgeSource = source;
  if (!item.command) item.command = { id: "ncforge.sql.acceptStat", title: "记录补全统计", arguments: [{ source }] };
  return item;
};

/** A snapshot is returned once. Learning and late metadata never reorder an already selected list. */
async function provideSqlAssistInner(model: monaco.editor.ITextModel, position: monaco.Position, context: monaco.languages.CompletionContext, token: monaco.CancellationToken): Promise<monaco.languages.CompletionList> {
  const checks = !token.isCancellationRequested && sqlAssistPickerChoices(model, position);
  if (checks) return checks;
  const tabId = tabIdOfModel(model), connId = sqlTabOf(tabId)?.connId;
  const rt = connId ? rtOf(connId) : null, identity = connectionKey(connId ? connOf(connId) : null);
  const schema = rt?.currentSchema ?? rt?.info?.schema ?? "", scope = connId ? sqlUsageScope(identity, schema) : null;
  const epoch = connId ? sqlColumnEpoch(connId) : 0;
  const version = model.getVersionId(), dialect = dialectOfSqlModel(model), analysis = sqlAnalysisOf(model), offset = model.getOffsetAt(position);
  const ctx = completionContext(analysis, offset, dialect);
  const predicate = getSqlTemplatesEnabled() ? sqlPredicateContext(analysis, offset, ctx.clause) : undefined;
  const word = model.getWordUntilPosition(position);
  const identifier = analysis.tokens.find(t => t.start < offset && t.end >= offset && ["identifier", "quoted"].includes(t.kind));
  const start = identifier?.start ?? offset - (position.column - word.startColumn);
  // 只取光标前那一小段：getValue() 会整文拷贝，大脚本下每次补全都白拷一份。
  const prefix = model.getValueInRange(monaco.Range.fromPositions(model.getPositionAt(ctx.valueStart ?? start), position)).replace(/^['"`[]/, "");
  const range = monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(identifier?.end ?? offset));
  const waitBudget = context?.triggerKind === monaco.languages.CompletionTriggerKind.Invoke ? 500 : 120;
  const archiveDeadline = Date.now() + waitBudget;
  const loadingItem: Item = {
    label: { label: "字段加载中", description: "到达后自动刷新" },
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
  const command = (key: string, followOperator = false, source = "") => scope ? { id: "ncforge.sql.accept", title: "记录补全选择", arguments: [{ scope, key, followOperator, ...(source ? { source } : {}) }] } : undefined;
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
  const visible = sources.filter(s => unique(s) && (ctx.clause !== "on" || analysis.tokens[s.declaration].start < offset));
  const qualifierText = (s: SqlSource) => s.aliasRef ?? (s.alias ? sqlIdentifier(s.alias, dialect) : s.nameRef ?? sqlIdentifier(s.name, dialect));
  // 光标不落在任何查询语句里 = 语句还没开始（空行、或刚敲完分号的新语句）。
  // 这是「先打表名、再补 select」的起点，也是唯一该把表名与整条查询模板端出来的位置；
  // 一旦进了 SELECT 投影 / WHERE，列表要留给字段。
  // 🔴 判据不能用 `analysis.scopes.length === 0`：脚本里前面写过语句就永远不为 0。
  const bare = !sqlScopeAt(analysis, offset);
  const tableList = rt?.tables ?? Object.keys(rt?.schema?.tables ?? {}).map(name => ({ name, kind: "TABLE" }));
  let catalog = tableCatalogCache.get(tableList);
  if (!catalog || catalog.names !== rt?.ncNames) {
    catalog = buildTableCatalog(tableList, rt?.ncNames);
    tableCatalogCache.set(tableList, catalog);
  }
  const { entries: tableEntries, tableNames, exact: exactTables, chinese: chineseTables } = catalog;
  const tables = (): Item[] => {
    if (!connId || ctx.kind === "schema" && ctx.schema?.toLowerCase() !== schema.toLowerCase()) return [];
    const shadowed = new Set(ctes.map(c => sqlReferenceKey(c.name, c.nameRef, dialect)));
    const favorites = rankedDbFavorites(connOf(connId), schema);
    return tableEntries.flatMap(t => {
      const name = t.normalized, zh = t.zh, quality = match(name, zh);
      if (quality === 9) return [];
      const insertText = sqlIdentifier(sqlWordKind(name, dialect) === "identifier" ? name : t.name, dialect);
      if (shadowed.has(sqlReferenceKey(name, insertText, dialect))) return [];
      const key = sqlUsageKey(insertText), favorite = favorites.size > 0 && favorites.has(favoriteKey(connId, "table", t.name));
      const why = favorite ? "已收藏" : reason(key);
      return [mark("table", { label: { label: name, description: sqlTableDescription({ zh, view: t.kind === "VIEW", why, connId, scope, prefix, name, available: tableNames }) }, kind: t.kind === "VIEW" ? K.Interface : K.Struct,
        insertText, filterText: filter(name), range, sortText: sqlAssistSort(quality, 4, name, scope, key, false, favorite), command: command(key, false, "table"),
        documentation: { value: `${schema ? schema + "." : ""}${name}${zh ? "\n\n" + zh : ""}${why ? "\n\n推荐依据：" + why : ""}` } })];
    });
  };
  const cteItems: Item[] = ctes.filter(c => match(c.name) < 9).map(c => mark("cte", { label: { label: c.name, description: "当前查询 CTE" }, kind: K.Interface, insertText: c.nameRef ?? sqlIdentifier(c.name, dialect), filterText: filter(c.name), range, sortText: sqlAssistSort(match(c.name), 0, c.name) }));
  /**
   * 列表为空时说明**为什么**空。
   *
   * 以前空列表就是一片空白，用户读成「这功能没有」；实际多半是没连库、正在连接，
   * 或者表清单还没加载。只报连接层面的缺失，不覆盖「只是没匹配上」——
   * 那会把每次 Esc 后的空列表变成一条永远甩不掉的废话。
   */
  const connectionNotice = (): Item[] => {
    const text = !connId ? "未连接数据库：表名与字段需要先建立连接"
      : rt?.status !== "connected" ? "正在连接数据库，表名与字段稍后可用"
        : tableList.length ? "" : "表清单还没加载：在左侧连接上刷新表结构";
    if (!text) return [];
    return [{ label: { label: text, description: "提示" }, kind: K.Text, insertText: "",
      filterText: filter(text), range: monaco.Range.fromPositions(position, position), sortText: "\uffff" }];
  };
  // 只在新语句的第一个词上预选查询，避免在其他语法位置扩写。
  const templates = async (): Promise<Item[]> => {
    if (!connId || !tableList.length || !getSqlTemplatesEnabled()) return [];
    const previous = analysis.tokens.filter(t => t.end <= start && !["space", "comment", "hint"].includes(t.kind)).pop();
    if (previous && previous.text !== ";") return [];
    const next = analysis.tokens.find(t => t.start >= (identifier?.end ?? offset) && !["space", "comment", "hint"].includes(t.kind));
    if (next && next.text !== ";") return [];
    const upper = getSqlFormatPrefs().keywordCase !== "lower";
    /** 后面已经跟了分号时不再补一个，否则 `t;` 会变成 `t;;`。 */
    const keepSemicolon = (sql: string) => next ? sql.replace(/;\$0$/, "$0") : sql;
    // 光标是空的：还不知道要查哪张表。给骨架，插完直接接表名（command 唤起补全）。
    if (!prefix) {
      const skel = querySkeleton(upper);
      return [mark("template", sqlExplicit({
        label: { label: skel.label, description: skel.hint }, kind: K.Snippet, insertText: skel.insertText,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range,
        sortText: "!", preselect: true,
        command: { id: "editor.action.triggerSuggest", title: "选择表" },
        ncforgePreview: { title: "查询模板", icon: "file-code", text: skel.insertText, note: skel.hint },
        documentation: { value: `\`\`\`sql\n${skel.label.trim()}\n\`\`\`` },
      }))];
    }
    const typed = prefix.toLowerCase();
    const named = tableEntries.map(t => ({ raw: t.name, name: t.normalized }));
    const exact = named.filter(t => t.name.toLowerCase() === typed);
    const chineseExact = named.filter(t => rt?.ncNames?.[t.name.toLowerCase()]?.toLowerCase() === typed);
    const candidates = exact.length ? exact : chineseExact.length ? chineseExact : named.filter(t => t.name.toLowerCase().startsWith(typed) || match(t.name, rt?.ncNames?.[t.name.toLowerCase()]) === 2);
    if (!candidates.length) return [];
    // 多张表命中**不再一条都不给**：每张表各挂一条整条查询，排在所有表名之后。
    // 原设计是「只给唯一命中的那张表」，理由是猜错要撤销一整条语句；代价是能力被锁死在
    // 「用户已经知道表名」这一种情况——而这条路径的全部价值恰恰是「打完前缀顺手拿到查询」，
    // 打 `po_` 命中 po_order / po_praybill 时反而什么都不给，用户只会读成「没有这功能」。
    // 多命中只挂 `SELECT * FROM`：COUNT / FOR UPDATE 与字段模板（联查、条件查询）仍只在
    // 唯一命中时给——那些要逐张读字段，几十张表各读一次会把一次补全拖成几秒。
    // 不做条数截断：截断会出现「第 31 张表没有模板」，同一批候选里有规律性的缺失比多几行更难解释。
    const single = candidates.length === 1;
    const idOf = (t: { raw: string; name: string }) => sqlIdentifier(sqlWordKind(t.name, dialect) === "identifier" ? t.name : t.raw, dialect);
    const items: Item[] = candidates.flatMap((t) => {
      const id = idOf(t), quality = match(t.name, rt?.ncNames?.[t.name.toLowerCase()]), head = sqlAssistSort(quality, 4, t.name);
      const list = tableTemplates(id, upper, dialect).slice(0, single ? 3 : 1);
      return list.map((tpl, i): Item => mark("template", sqlExplicit({
        label: { label: tpl.label, description: tpl.hint }, kind: K.Snippet, insertText: keepSemicolon(tpl.insertText),
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        filterText: filter(t.name), range,
        // 多命中时整组排在表名（group 4）之后：先让人把表挑完，再往下拿整条查询。
        sortText: single ? (i === 0 ? `!${head}` : `${head}~${i}`) : sqlAssistSort(quality, 9, t.name),
        preselect: single && i === 0,
        ncforgePreview: { title: "查询模板", icon: "file-code", text: next ? tpl.label : `${tpl.label};`, note: tpl.hint },
        documentation: { value: `\`\`\`sql\n${tpl.label};\n\`\`\`` },
      })));
    });
    if (!single) return items;
    const { raw, name } = candidates[0], insertText = idOf(candidates[0]), head = sqlAssistSort(match(name, rt?.ncNames?.[name.toLowerCase()]), 4, name);
    if (!scope || rt?.status !== "connected" || !/^[a-z_][\w$#]*$/i.test(raw) || mixed(raw) || insertText !== name || dialect !== "plsql") return items;
    const deadline = Date.now() + waitBudget;
    const [metadata, rootColumns] = await Promise.all([
      early(readSqlBusinessMetadata(connId, scope, name, metadataCurrent), null, waitBudget),
      early(readColumns({ table: name, tableRef: name, name, declaration: 0 }), [], waitBudget),
    ]);
    if (stale()) return items;
    // Keep one completion within its original time budget and bound cold metadata reads.
    const relations = rootColumns.length
      ? rankBillRelations(name, billQueryRelations(name, tableNames, metadata), rt.ncNames)
        .slice(0, 8).map(item => item.relation) : [];
    const billColumns = await Promise.all([...new Set(relations.map(r => r.table))].map(async table =>
      [table, await early(readColumns({ table, tableRef: table, name: table, declaration: 0 }), [], Math.max(0, deadline - Date.now()))] as const));
    if (stale()) return items;
    const columns = { [name]: rootColumns, ...Object.fromEntries(billColumns) };
    const checkContext = { tables: tableNames, columns, names: rt.ncNames, schema, upper };
    const checkTemplates = [...buildBillRelationChecks(name, relations, checkContext), ...buildIncomingDetailCountChecks(name, metadata, checkContext)]
      .map(t => ({ ...t, insertText: snippetEscape(t.sql).slice(0, -1) + "$0;", pickField: false }));
    const queries = [...conditionQueryTemplates(name, rt.ncNames ?? {}, columns, relations, upper, dialect), ...billQueryTemplates(name, rt.ncNames ?? {}, columns, relations, upper, dialect), ...completeQueryTemplates(name, rt.ncNames ?? {}, columns, relations, upper), ...checkTemplates];
    const bills: Item[] = queries.map((tpl, i) => mark("template", sqlExplicit({
      // 关联编号和条件都在详情里，候选行只需告诉用户查哪张表。
      label: { label: tpl.label, description: /^(外键|NC类引用|主子表) · /.exec(tpl.hint)?.[1] }, kind: K.Snippet,
      insertText: next ? tpl.insertText.slice(0, -1) : tpl.insertText,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      filterText: filter(name), range, sortText: `${head}~8${String(i).padStart(2, "0")}`,
      command: tpl.pickField ? { id: "editor.action.triggerSuggest", title: "选择条件字段" } : undefined,
      ncforgePreview: { title: "scope" in tpl ? "关联核查" : tpl.pickField ? "条件模板" : "查询模板",
        icon: "scope" in tpl ? "checklist" : tpl.pickField ? "filter" : "file-code",
        get text() { return sqlPreviewSnippet(next ? tpl.insertText.slice(0, -1) : tpl.insertText); },
        note: tpl.hint, current: metadataCurrent },
      documentation: { value: `${tpl.label}\n\n${tpl.hint}\n\n\`\`\`sql\n${tpl.sql}\n\`\`\`` },
    })));
    const related = metadata ? sqlRelatedQueries(metadata, rt.ncNames ?? {}, upper, dialect) : [];
    return [...items, ...bills, ...related.map((item, i): Item => mark("related", sqlExplicit({
      label: { label: item.label, description: item.reason },
      kind: K.Snippet, filterText: filter(name), range, sortText: `${head}~9${i}`,
      insertText: next ? item.insertText.slice(0, -1) : item.insertText,
      ncforgePreview: { title: "相关查询", icon: "history", text: next ? item.insertText.slice(0, -1) : item.insertText, note: item.source, current: metadataCurrent },
      documentation: { value: `${item.label}\n\n${item.source}\n\n\`\`\`sql\n${item.insertText}\n\`\`\`` },
    })))];
  };
  /** 光标前词精确命中的表；半截前缀、或必须加引号才成立的标识符返回空。 */
  const billHit = (text = prefix) => {
    if (!text) return "";
    const typed = text.toLowerCase(), name = exactTables.has(typed) ? typed : chineseTables.get(typed);
    return name && !mixed(name) && sqlIdentifier(name, dialect) === name ? name : "";
  };
  /**
   * 表位置（`SELECT * FROM po_order`）精确命中时预读一次业务关系。
   *
   * `tables()` 里那句「N 个关联表 · 支持主子表联查」读的是同步快照
   * （`peekSqlBusinessMetadata`），而这条分支原先根本不发起查询 —— 最常见的
   * FROM 写法因此永远看不到标注，只有裸表名起手（`bare` 分支）才有。
   *
   * 只在**打全一张表**时读：半截前缀不猜，也不会为几千张表逐张查。
   */
  const warmBillHints = async (): Promise<void> => {
    if (!connId || !scope || rt?.status !== "connected" || dialect !== "plsql") return;
    const name = billHit();
    // 字段一起预读：否则「打全表名 → 别名 → 点」这条最常见的路第一次点号必然冷读，
    // 自动预算内拿不到字段，用户看到的是一片空白或一行加载中。
    if (name) await early(Promise.all([
      readSqlBusinessMetadata(connId, scope, name, metadataCurrent),
      readColumns({ table: name, tableRef: name, name, declaration: 0 }),
    ]), null, waitBudget);
  };
  /**
   * 表名上的「接上子表」。替换范围整词覆盖（词+JOIN 替换词本身），光标在词中间
   * 也不会把 JOIN 塞进标识符；要求光标恰在词末会漏掉「写完一句回看」的常见姿态。
   */
  const joinSnippets = () => {
    if (!connId || !scope || rt?.status !== "connected" || dialect !== "plsql" || !identifier || !getSqlTemplatesEnabled()) return;
    const name = billHit() || billHit(identifier.text);
    if (!name) return;
    const source = sources[0];
    if (!source || source.table?.toLowerCase() !== name || source.alias || source.quoted || source.schema && source.schema.toLowerCase() !== schema.toLowerCase()) return;
    const query = sqlScopeAt(analysis, offset);
    const insertion = query && sqlJoinInsertion(analysis, query, model.getValue());
    if (!query || !insertion || insertion.chain.some(token => token.text === ",")) return;
    const word = identifier.text, wordRange = monaco.Range.fromPositions(model.getPositionAt(identifier.start), model.getPositionAt(identifier.end));
    const specs = sqlJoinAppendChoices(analysis, query, insertion, source, schema,
      billJoinSpecs(name, tableNames, peekSqlBusinessMetadata(connId, scope, name), rt?.ncNames))
      .filter(choice => !choice.added).map(({spec, sql}) => ({ ...spec, sql: " " + sql }));
    const joinCurrent = () => metadataCurrent() && sqlTabOf(tabId)?.connId === connId && rtOf(connId).status === "connected" && getSqlTemplatesEnabled();
    const editCurrent = () => !model.isDisposed() && model.getVersionId() === version && joinCurrent();
    const details = specs.filter(spec => spec.group === "detail");
    const suggestions = (details.length ? details.slice(0, 3) : specs.slice(0, 1)).map((spec, i) => mark("billjoin", sqlExplicit({
      label: { label: `追加 LEFT JOIN · ${rt?.ncNames?.[spec.table] || spec.table}`, description: billJoinGroupLabels[spec.group] }, kind: K.Snippet,
      insertText: word + spec.sql, filterText: filter(name), range: wordRange,
      sortText: sqlAssistSort(match(name), 5, `join${String(i).padStart(4, "0")}`),
      ncforgePreview: { title: "主子表联查", icon: `ncforge-join-${sqlJoinIcon(spec.table, spec.group, tableList.some(t => t.name.toLowerCase() === spec.table && t.kind.toUpperCase().includes("VIEW")))}`,
        text: sqlJoinAppendText(insertion, [spec.sql.trimStart()]).preview, note: `${spec.table} · ${spec.source}`, current: editCurrent },
      ncforgeApply: editor => applySqlJoinAppend(editor, model, insertion, analysis.tokens[source.declaration].start,
        [spec.sql.trimStart()], editCurrent, joinCurrent),
      documentation: { value: `${rt?.ncNames?.[spec.table] || spec.table} · ${spec.source}\n\n\`\`\`sql\nSELECT *\nFROM ${name}\n${spec.sql.trimStart().replace(" ON ", "\n    ON ")}\n\`\`\`` },
    })));
    return { suggestions, recommend: details.length > 0 && prefix.toLowerCase() === name && identifier.text.toLowerCase() === name };
  };
  /** 光标前（或光标下）那个词如果是当前 schema 的表，返回小写规范名。 */
  const tableAtCaret = (): string => {
    const before = analysis.tokens.filter(t => t.end <= offset && !["space", "comment", "hint"].includes(t.kind)).pop();
    const typed = (identifier?.text ?? before?.text ?? "").toLowerCase();
    if (!typed) return "";
    const hit = tableList.find(t => normalized(t.name).toLowerCase() === typed)
      ?? tableList.find(t => (rt?.ncNames?.[t.name.toLowerCase()] ?? "").toLowerCase() === typed);
    const name = hit ? normalized(hit.name) : "";
    return name && !mixed(name) && sqlIdentifier(name, dialect) === name ? name : "";
  };
  /** 同步快照里已知的主子表关系数；没解析过就是 0。 */
  const relationCount = (name: string): number => {
    if (!connId || !scope) return 0;
    const meta = peekSqlBusinessMetadata(connId, scope, name);
    if (!meta) return 0;
    const specs = billJoinSpecs(name, tableNames, meta);
    if (bare || !specs.length) return specs.length;
    const query = sqlScopeAt(analysis, offset);
    const source = query?.sources.find(source => source.table?.toLowerCase() === name
      && analysis.tokens[source.declaration].start <= offset && offset <= analysis.tokens[source.declaration].end + 1);
    const insertion = source && query && sqlJoinInsertion(analysis, query, model.getValue());
    return insertion ? sqlJoinAppendChoices(analysis, query, insertion, source, schema, specs).filter(choice => !choice.added).length : 0;
  };
  /**
   * 光标所在语句能不能放 INSERT 模板：得是普通 SQL，不能是 PL/SQL 块。
   *
   * 判据与 `ncforge.sql.insertTemplate` 的实现（`sqlEditorAssist` 的 `fields(true)`）
   * 同源。不同源的后果是：补全里给了这条动作，点下去只弹一句「请在普通 SQL 语句中
   * 生成 INSERT 模板」——比不给更糟。
   */
  // 语句切分一次补全最多算一遍（且只在真要判 INSERT 模板时才算）：
  // 以前每个候选动作都 getValue()+splitStatements 整文重切。
  let statementsCache: ReturnType<typeof splitStatements> | null = null;
  const insertableAt = (name: string): boolean => {
    if (!name) return false;
    statementsCache ??= splitStatements(model.getValue());
    const statement = statementsCache.find(s => s.start <= offset && s.end >= offset);
    return !!statement && !isPlsql(statement.text);
  };
  const wildcard = sqlWildcardAt(analysis, offset);
  const expandable = !!connId && rt?.status === "connected";
  const verifiedWildcard = expandable && wildcard?.source && verifiedSqlSource(connId, wildcard.source);
  const onStar = !!verifiedWildcard && !verifiedWildcard.quoted;
  /**
   * 位置允许的动作，混进补全列表。
   *
   * 这些能力原先只有「Ctrl+. 或灯泡」一条路（而灯泡因为 `glyphMargin` 是关着的
   * 根本没画出来），用户不知道有。放进补全列表，按 Ctrl+空格 就能看见
   * 「这儿还能做什么」。选中不插入任何字符，只唤起真正的实现——不复制判定，
   * 避免两处走偏。
   *
   * 🔴 四条硬约束（每一条都是踩过的坑）：
   * 1. `preselect` 恒 false：`suggestSelection: "first"` 下把动作放首位，
   *    等于把 Enter 绑给了「展开 31 个字段」；
   * 2. 关键词命中时 **label 必须以关键词打头**：Monaco 拿 `filterText` 去套 `label`
   *    算高亮区间，两者不等长会把中文标题开头几个字涂成高亮色，看着像乱码；
   * 3. `range` 参与关键词匹配。`exp` 在实际展开时和星号一起修改，取消预览时保留输入。
   * 4. 只有「光标真压在 `*` 上」才允许置顶。这是唯一一个「按 Ctrl+空格的第一眼
   *    就该是它」的位置；其余位置置顶只会打乱正常的字段补全。
   */
  const actionItems = (): Item[] => {
    const name = tableAtCaret();
    const relations = name ? relationCount(name) : 0;
    const directory = sqlActionsAt({
      plsql: dialect === "plsql", templatesEnabled: getSqlTemplatesEnabled(), bare,
      table: name, relations,
      wildcard: expandable && (onStar || !!sqlWildcardInScope(analysis, offset)),
      // INSERT 模板只在裸表名位置进列表（语句内那里会变成噪音），所以也只在裸位置算分句。
      insertable: bare && insertableAt(name),
    });
    // 语句里另有 `*` 不等于「现在就想展开它」：只有光标真压在 `*` 上，或者用户
    // 主动打了 `exp` 才把这条推出来。否则每一条表名补全都会多出一行无关动作。
    const actions = directory.filter(action => action.id !== "star.expand" || onStar || !!keywordFor(action, prefix));
    return actions.map((action, i): Item => {
      const keyword = keywordFor(action, prefix), direct = ACTION_COMMANDS[action.id];
      const title = action.id === "bill.join" ? "查看全部关联" : action.title;
      const item: Item = sqlExplicit({
        label: keyword ? { label: keyword, detail: ` ${title}`, description: action.detail }
          : { label: title, description: action.id === "bill.join" ? `${relations} 张表` : "SQL 操作" },
        kind: K.Event, insertText: "",
        filterText: keyword || prefix || action.title,
        range: keyword ? monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(offset)) : monaco.Range.fromPositions(position, position),
        // `\u0000` 排在所有正常 sortText 之前（表名用 `!`、关键字用数字），`\ufffe` 排在最后。
        sortText: `${keyword || onStar ? "\u0000" : "\ufffe"}${String(i).padStart(2, "0")}`,
        preselect: false,
        command: direct ? { id: "ncforge.sql.runAction", title: action.title, arguments: [direct] } : { id: "ncforge.sql.quickFix", title: action.title },
        documentation: { value: action.detail },
      });
      // 动作条目已有命令，只计曝光不计接受（口径在设置页明示）。
      item.ncforgeSource = "action";
      if (keyword && action.id === "star.expand" && direct) {
        const current = () => !model.isDisposed() && model.getVersionId() === version && metadataCurrent();
        item.ncforgePreview = { title: "展开字段", icon: "symbol-field", description: true, text: "查看展开后的查询后即可应用。", current };
        item.ncforgeApply = editor => {
          if (current() && editor.getModel() === model) editor.trigger("sql-assist", "ncforge.sql.runAction", { id: direct, keyword: { start, end: offset } });
        };
      }
      return item;
    });
  };
  if (ctx.kind === "none" || stale()) return { suggestions: [] };
  if (onStar) {
    const columns = await readColumns(verifiedWildcard);
    if (stale() || !columns.length) return { suggestions: [] };
    const qualifier = wildcard?.qualifier ? `${wildcard.qualifier}.` : "";
    const fields = sqlFieldIdentifiers(columns, dialect).map(name => qualifier + name);
    const item = actionItems().find(item => item.command?.arguments?.[0] === "ncforge.sql.expandStar");
    if (item && wildcard && typeof item.label !== "string") {
      item.label.description = `${fields.length} 个字段`;
      item.kind = K.Field;
      const token = analysis.tokens[wildcard.token];
      const sql = model.getValue();
      const statement = splitStatements(sql).find(s => s.start <= token.start && s.end >= token.end);
      // The first qualifier, when present, is already part of the statement before the star.
      const expanded = [fields[0].slice(qualifier.length), ...fields.slice(1)].join(",\n  ");
      const current = () => !model.isDisposed() && model.getVersionId() === version && sqlTabOf(tabId)?.connId === connId && metadataCurrent();
      item.ncforgePreview = { title: "展开字段", icon: "symbol-field", current,
        text: statement ? sql.slice(statement.start, token.start) + expanded + sql.slice(token.end, statement.end) : fields.join(",\n  ") };
      item.ncforgeApply = editor => {
        if (!current() || editor.getModel() !== model) return;
        editor.pushUndoStop();
        editor.executeEdits("sql-assist", [{ range: monaco.Range.fromPositions(model.getPositionAt(token.start), model.getPositionAt(token.end)),
          text: [fields[0].slice(qualifier.length), ...fields.slice(1)].join(", ") }]);
        editor.pushUndoStop(); editor.focus();
      };
      item.documentation = undefined;
    }
    return { suggestions: item ? [item] : [] };
  }
  if (ctx.kind === "table") {
    await warmBillHints();
    // 多了这一次 await，模型可能在等待期间被改过；此时 range/prefix 都已过期。
    if (stale()) return { suggestions: [] };
    const joins = joinSnippets(), actions = actionItems();
    const items = joins?.recommend ? [...joins.suggestions, ...actions]
      : [...cteItems, ...tables(), ...(joins?.suggestions ?? []), ...actions];
    return { suggestions: items.length ? items : connectionNotice(), incomplete: true };
  }
  if (ctx.kind === "schema") {
    const items = tables();
    if (items.length) return { suggestions: items, incomplete: true };
    // 跨 schema 前缀（`other.`）在这里必然是空：表清单只装了当前 schema。
    // 空列表一句话都不说，用户读成「这个库没表」。
    return { suggestions: [{ label: { label: `只补全当前 schema（${schema || "未连接"}）的表`, description: "提示" }, kind: K.Text,
      insertText: "", filterText: prefix || "schema", range: monaco.Range.fromPositions(position, position), sortText: "\uffff",
      documentation: { value: "要查其他 schema 的表，请先在连接里切换 schema 或手动写全名。" } }], incomplete: true };
  }
  const relationTable = (source: SqlSource) => {
    if (!connId || !scope || rt?.status !== "connected") return;
    const verified = verifiedSqlSource(connId, source);
    if (verified && !verified.quoted) return verified.table.toLowerCase();
  };
  const warmColumnRelations = async (sources: readonly SqlSource[]) => {
    if (!connId || !scope || stale()) return;
    const tables = [...new Set(sources.map(relationTable).filter((table): table is string => !!table))].slice(0, 2);
    if (!tables.length) return;
    // Share isolated metadata requests with JOIN suggestions and keep the normal completion budget.
    await early(Promise.all(tables.filter(table => !peekSqlBusinessMetadata(connId, scope, table))
      .map(table => readSqlBusinessMetadata(connId, scope, table, metadataCurrent))), null, Math.min(waitBudget, 100));
  };
  const fromColumns = (source: SqlSource, cols: ColumnInfo[], qualified: boolean): Item[] => {
    const table = relationTable(source);
    const meta = table && connId && scope ? peekSqlBusinessMetadata(connId, scope, table) : null;
    const byColumn = new Map<string, { foreign: boolean; details: string[] }>();
    if (table && meta?.table.toLowerCase() === table && !meta.sharedSession && (!meta.schema || meta.schema.toLowerCase() === schema.toLowerCase())) {
      for (const relation of meta.relations) {
        if (relation.source.toLowerCase() !== table || relation.kind === "主子表") continue;
        relation.from.forEach((field, index) => {
          const target = relation.to[index];
          if (!target) return;
          const info = byColumn.get(field) ?? { foreign: false, details: [] };
          info.foreign ||= relation.kind === "外键";
          const composite = relation.from.length > 1 ? `（${index + 1}/${relation.from.length}）` : "";
          const detail = `${relation.kind}${composite} · ${field} → ${relation.target}.${target}`;
          if (!info.details.includes(detail)) info.details.push(detail);
          byColumn.set(field, info);
        });
      }
    }
    const primary = cols.filter(c => c.pk).map(c => c.name);
    const primaryDetail = primary.length > 1 ? `联合主键 · ${primary.join(" + ")}` : "主键";
    return cols.flatMap(c => {
      const name = normalized(c.name), quality = match(name, c.zh ?? "");
      if (quality === 9) return [];
      qualified ||= predicate?.kind === "field" && ctx.kind !== "column";
      const q = qualifierText(source), insertText = `${qualified ? q + "." : ""}${sqlIdentifier(sqlWordKind(name, dialect) === "identifier" ? name : c.name, dialect)}`;
      const key = source.table ? sqlUsageKey(objectKey(source), name, ctx.clause) : undefined, why = key ? reason(key) : "";
      const relation = byColumn.get(c.name), foreign = !!relation?.foreign;
      const details = [...(c.pk ? [primaryDetail] : []), ...(relation?.details ?? [])];
      const base: Item = mark("column", { label: { label: qualified ? `${source.alias ?? source.name}.${name}` : name, detail: ` ${c.full}`, description: [c.zh, source.tableRef || source.name, why].filter(Boolean).join(" · ") }, kind: K.Field,
        ncforgeColumnKeys: c.pk || foreign ? { primary: !!c.pk, foreign, detail: details.join("\n") } : undefined,
        insertText, filterText: filter(name), range, sortText: sqlAssistSort(quality, c.pk ? 0 : foreign ? 1 : 2, insertText, scope, key, ctx.assigned.includes(name)), command: key ? command(key, false, "column") : undefined,
        documentation: { value: [`${source.tableRef ?? source.name}.${name}`, `${c.full}${c.zh ? " · " + c.zh : ""}`, ...details, why].filter(Boolean).join("\n\n") } });
      if (predicate?.kind !== "field") return [base];
      // A typed alias stays outside the replacement range, but repeated range operands still need it.
      const conditionPrefix = ctx.kind === "column" ? q + "." : "";
      const options = [...sqlPredicates(conditionPrefix + insertText, c.full || c.type || "", dialect, getSqlFormatPrefs().keywordCase !== "lower"), ...sqlTimePresets(conditionPrefix + insertText, c.full || c.type || "", dialect, getSqlFormatPrefs().keywordCase !== "lower")];
      const exact = !!prefix && (prefix.toLowerCase() === name.toLowerCase() || prefix === c.zh);
      const selected = options.filter(p => (exact || p.operator === "=") && (!predicate.negated || p.operator !== "RANGE" && !p.operator.startsWith("TIME_")));
      const items = selected.map((p, i): Item => mark(p.operator.startsWith("TIME_") ? "time" : "predicate", { ...base, command: undefined, kind: K.Snippet, ncforgeColumnKeys: undefined,
        label: { label: `${qualified ? q + "." : ""}${name} · ${p.label}`, description: [c.zh, source.tableRef || source.name, p.hint].filter(Boolean).join(" · ") },
        insertText: p.insertText.slice(snippetEscape(conditionPrefix).length), insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        sortText: `${base.sortText}~${String(i).padStart(2, "0")}`, documentation: { value: `${source.tableRef ?? source.name}.${name}\n\n${p.hint}\n\n${p.label} · ${c.full}` },
        ncforgePreview: { title: "条件模板", icon: p.operator.startsWith("TIME_") ? "history" : "filter", note: p.hint,
          get text() { return sqlPreviewSnippet(p.insertText); }, current: metadataCurrent },
      }));
      // Keep the direct field+operator templates below the field-first path.
      return [{ ...base, insertText: insertText + " ", command: key ? command(key, true, "column") : base.command }, ...items];
    });
  };
  if (predicate?.kind === "operator") {
    const cols = await early(readColumns(predicate.source), null, waitBudget);
    const fieldKey = sqlReferenceKey(predicate.field, predicate.fieldRef, dialect);
    const columns = cols?.filter(c => sqlReferenceKey(normalized(c.name), mixed(c.name) ? sqlIdentifier(c.name, dialect) : undefined, dialect) === fieldKey) ?? [];
    const column = columns.length === 1 ? columns[0] : undefined;
    const id = `${qualifierText(predicate.source)}.${predicate.fieldRef}`;
    const options = column ? [...sqlPredicates(id, column.full || column.type || "", dialect, getSqlFormatPrefs().keywordCase !== "lower"), ...sqlTimePresets(id, column.full || column.type || "", dialect, getSqlFormatPrefs().keywordCase !== "lower")] : [];
    return { suggestions: stale() ? [] : cols === null ? [loadingItem] : options.filter(p => match(p.operator, p.label) < 9 && (!predicate.negated || p.operator !== "RANGE" && !p.operator.startsWith("TIME_"))).map((p, i) => mark(p.operator.startsWith("TIME_") ? "time" : "predicate", {
      label: { label: `${p.operator.startsWith("TIME_") ? "时间快捷" : p.operator === "RANGE" ? ">= … AND < …" : p.operator} · ${p.label}`, description: p.hint }, kind: K.Snippet,
      insertText: p.suffix, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, filterText: filter(p.label),
      range: monaco.Range.fromPositions(model.getPositionAt(predicate.start), model.getPositionAt(predicate.end)), sortText: String(i).padStart(2, "0"),
      ncforgePreview: { title: "条件模板", icon: p.operator.startsWith("TIME_") ? "history" : "filter", note: p.hint,
        get text() { return sqlPreviewSnippet(p.insertText); }, current: metadataCurrent },
    })), incomplete: true };
  }
  const derived = (source: SqlSource, qualified: boolean): Item[] => (source.columns ?? []).filter(name => match(name) < 9).map(name => mark("derived", { label: { label: qualified ? `${source.alias ?? source.name}.${name}` : name, description: "查询输出 · " + (source.alias ?? source.name) }, kind: K.Field,
    insertText: `${qualified ? qualifierText(source) + "." : ""}${sqlIdentifier(name, dialect)}`, filterText: filter(name), range, sortText: sqlAssistSort(match(name), 1, name) }));
  const archives = async (source: SqlSource, columns: ColumnInfo[]): Promise<Item[]> => {
    if (!prefix || !getSqlTemplatesEnabled() || dialect !== "plsql" || ctx.clause !== "select" || !connId || !scope || rt?.status !== "connected"
      || source.quoted || !source.table || source.schema && source.schema.toLowerCase() !== schema.toLowerCase()) return [];
    const projection = archiveProjectionAt(analysis, start, identifier?.end ?? offset, source);
    const fields = columns.filter(c => match(normalized(c.name), c.zh ?? "") <= 2).slice(0, 4);
    if (!projection || !fields.length) return [];
    const remaining = () => Math.max(0, archiveDeadline - Date.now());
    const meta = await early(readSqlBusinessMetadata(connId, scope, source.table, metadataCurrent), null, remaining());
    if (stale()) return [];
    const relations = fields.flatMap(field => archiveRelations(source, field.name, tableNames, meta).map(relation => ({ field, relation }))).slice(0, 4);
    const items = await Promise.all(relations.map(async ({ field, relation }): Promise<Item | undefined> => {
      const table = relation.target.toLowerCase(), targetColumns = await early(readColumns({ name: table, table, tableRef: table, declaration: 0 }), [], remaining());
      if (stale()) return;
      const expansion = archiveExpansion(analysis, projection, source, field, columns, relation, targetColumns, getSqlFormatPrefs().keywordCase !== "lower");
      if (!expansion) return;
      const key = sqlUsageKey(objectKey(source), normalized(field.name), "select");
      const sql = model.getValue();
      const statement = splitStatements(sql).find(s => s.start <= projection.start && s.end >= projection.end);
      const edits = [{ start: projection.start, end: projection.end, text: expansion.insertText }];
      if (expansion.join) edits.push({ start: expansion.join.offset, end: expansion.join.offset, text: expansion.join.text });
      return mark("archive", { label: { label: `${qualifierText(source)}.${normalized(field.name)} · 展开档案编码和名称`, description: `${rt.ncNames?.[table] || table} · ${relation.kind}` },
        kind: K.Snippet, insertText: expansion.insertText, filterText: model.getValueInRange(monaco.Range.fromPositions(model.getPositionAt(projection.start), model.getPositionAt(offset))),
        range: monaco.Range.fromPositions(model.getPositionAt(projection.start), model.getPositionAt(projection.end)),
        additionalTextEdits: expansion.join ? [{ range: monaco.Range.fromPositions(model.getPositionAt(expansion.join.offset), model.getPositionAt(expansion.join.offset)), text: expansion.join.text }] : undefined,
        ncforgeExplicit: true as const,
        ncforgePreview: { title: "引用字段展开", icon: "references", note: `${table} · 增加 ${expansion.code}、${expansion.name}`,
          current: () => !model.isDisposed() && model.getVersionId() === version && metadataCurrent(),
          ...(statement ? sqlPreviewEdits(sql, statement.start, statement.end, edits) : { text: edits.map(edit => edit.text).join("\n") }) },
        sortText: `${sqlAssistSort(match(normalized(field.name), field.zh ?? ""), 1, normalized(field.name))}~archive`, command: command(key, false, "archive"),
        documentation: { value: `保留引用主键，增加 ${table}.${expansion.code} 与 ${table}.${expansion.name}。\n\n已确认完整目标主键，LEFT JOIN 保留原行数。\n\n\`\`\`sql\n${expansion.insertText}${expansion.join?.text ?? ""}\n\`\`\`` } });
    }));
    return items.filter((item): item is Item => !!item);
  };
  if (ctx.kind === "column") {
    const resolved = resolveSqlQualifier(analysis, offset, ctx.qualifier!, ctx.qualifierRef);
    const source = resolved && ctx.clause === "on" && analysis.tokens[resolved.declaration].start >= offset ? undefined : resolved;
    const [columns] = source?.table ? await Promise.all([
      early(readColumns(source), null, waitBudget), !prefix || context?.triggerKind === monaco.languages.CompletionTriggerKind.Invoke ? warmColumnRelations([source]) : undefined,
    ]) : [];
    const suggestions = !source ? [] : columns === null ? [loadingItem] : columns ? [...fromColumns(source, columns, false), ...await archives(source, columns)] : derived(source, false);
    return { suggestions: stale() ? [] : suggestions.length ? suggestions : connectionNotice(), incomplete: true };
  }
  const businessItem = (s: BusinessSuggestion, source: string, targetRange = range): Item => mark(source, { label: { label: s.label, detail: ctx.clause === "on" && ctx.kind !== "value" ? `  ${s.insertText}` : undefined, description: s.reason }, kind: K.Snippet, insertText: s.insertText, range: targetRange,
    insertTextRules: s.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    ncforgePreview: source === "enum" ? undefined : { title: source === "condition" ? "条件模板" : "关联条件", icon: source === "condition" ? "filter" : source === "joinhistory" ? "history" : "references",
      text: s.snippet ? sqlPreviewSnippet(s.insertText) : s.insertText, note: s.source, current: metadataCurrent },
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
    const suggestions = meta && column ? sqlEnumSuggestions(meta, ctx.field!, column.full).filter(s => !prefix || match(s.label, s.insertText) < 9).map(s => businessItem(s, "enum", monaco.Range.fromPositions(model.getPositionAt(ctx.valueStart!), model.getPositionAt(ctx.valueEnd!)))) : [];
    return { suggestions: stale() ? [] : suggestions, incomplete: true };
  }
  const loaded = new Map<SqlSource, ColumnInfo[]>();
  // Two reads at a time, with an early snapshot for a cold query. Aliases keep every source discoverable.
  let next = 0;
  const budget = visible.slice(0, 32);
  const load = async () => { while (next < budget.length && !stale()) { const source = budget[next++]; if (source.table) loaded.set(source, await readColumns(source)); } };
  const [fieldsReady] = await Promise.all([
    early(Promise.all([load(), load()]).then(() => true), false, waitBudget),
    !prefix && context?.triggerKind === monaco.languages.CompletionTriggerKind.Invoke ? warmColumnRelations(visible) : undefined,
  ]);
  if (stale()) return { suggestions: [] };
  const cols = visible.flatMap(s => s.table ? fromColumns(s, loaded.get(s) ?? [], sources.length > 1) : derived(s, sources.length > 1));
  const archiveItems = (await Promise.all(visible.slice(0, 4).map(s => archives(s, loaded.get(s) ?? [])))).flat();
  const aliases: Item[] = visible.filter(s => match(s.alias ?? s.name) < 9).map(s => mark("alias", { label: { label: s.alias ?? s.name, description: `来源 ${s.tableRef ?? "查询输出"} · 输入 . 查看字段` }, kind: K.Variable, insertText: qualifierText(s), filterText: filter(s.alias ?? s.name), range, sortText: sqlAssistSort(match(s.alias ?? s.name), 3, s.name) }));
  // 无前缀（Ctrl+空格）时函数按子句收窄，否则 58 个函数会把字段和表名挤出可见区；
  // 有前缀就是在找函数，全量交前缀过滤。`SYSDATE` / `USER` 无参，不能补出 `SYSDATE()`。
  const functions: Item[] = sqlAssistFunctionsFor(dialect, ctx.clause, !!prefix).filter(f => match(f.name) < 9 && !["set", "order", "group"].includes(ctx.clause)).map(f => mark("function", { label: { label: f.name, detail: f.args.length ? `(${f.args.join(", ")})` : "", description: f.description }, kind: K.Function,
    insertText: f.snippet ?? (f.args.length ? `${f.name}(${f.args.map((arg, i) => `\${${i + 1}:${arg}}`).join(", ")})` : f.name), insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, filterText: filter(f.name), range, sortText: sqlAssistSort(match(f.name), 6, f.name), documentation: f.description }));
  const keywords: Item[] = sqlAssistKeywords(ctx.clause, dialect).filter(k => match(k) < 9).map(k => mark("keyword", { label: k, kind: K.Keyword, insertText: k, filterText: filter(k), range, sortText: sqlAssistSort(match(k), 7, k) }));
  const snippets: Item[] = prefix ? filterSnippets(listSnippets(connId ?? null), prefix).map(s => {
    const insertText = sqlSnippetText(s.sql);
    return mark("snippet", { label: { label: s.name, description: "已保存 SQL 片段" }, kind: K.Snippet, insertText, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      filterText: filter(s.name), range, sortText: sqlAssistSort(match(s.name, s.sql), 5, s.name), documentation: { value: s.sql },
      ncforgePreview: { title: "SQL 片段", icon: "bookmark", note: s.name, get text() { return sqlPreviewSnippet(insertText); } } });
  }) : [];
  const projections: Item[] = ctx.projections.filter(name => match(name) < 9).map(name => mark("projection", { label: { label: name, description: "当前 SELECT 输出" }, kind: K.Field, insertText: sqlIdentifier(name, dialect), filterText: filter(name), range, sortText: sqlAssistSort(match(name), 0, name) }));
  const business: Item[] = [];
  // Later JOIN tables exist in the parsed query, but are unavailable in this ON condition.
  const onSources = physical.filter(s => analysis.tokens[s.declaration].start < offset);
  if (predicate?.kind === "field" && !predicate.negated && ctx.clause === "on" && onSources.length > 1) {
    const source = onSources[onSources.length - 1], meta = await metadata(source);
    const verifiedSources = onSources.map(s => ({ ...s, table: s.table! }));
    if (meta) business.push(...sqlJoinSuggestions({ ...meta, schema }, verifiedSources, source.alias ?? source.name, dialect).filter(s => !prefix || match(s.label, s.insertText) < 9).map(s => businessItem(s, "join")));
    if (scope) business.push(...sqlHistoricalJoinSuggestions(scope, verifiedSources, Object.fromEntries(onSources.map(s => [s.tableRef ?? s.table!, (loaded.get(s) ?? []).map(c => ({ name: c.name, type: c.full }))])), dialect).filter(s => !prefix || match(s.label, s.insertText) < 9).map(s => ({ ...businessItem(s, "joinhistory"), sortText: `${match(s.label, s.insertText)}01${s.label}` })));
  }
  if (predicate?.kind === "field" && ctx.clause === "where") for (const source of physical) business.push(...sqlConditionSuggestions({ ...source, table: source.table! }, (loaded.get(source) ?? []).map(c => ({ name: c.name, type: c.full })), dialect).filter(s => !prefix || match(s.label, s.insertText) < 9).map(s => businessItem(s, "condition")));
  // 语句还没开始时，表名才是这个位置最该出现的东西。`any` 分支其余内容（字段、别名、
  // 函数、关键字）在这个位置基本都用不上，所以表名与模板排在最前面。
  // 已知取舍：超过 `SQL_ANALYSIS_LIMIT`（200k 字符）或 512 条语句的脚本里 `analyzeSql`
  // 会放弃建 scope，此时 `bare` 对所有位置都为真——但那时整条链路本来就没有上下文可用，
  // 多出来的表名仍然按输入的前缀过滤，不会误导。
  // 先算模板：`templates()` 读到的业务关系会落进 `peekSqlBusinessMetadata` 的同步副本，
  // 紧接着的 `tables()` 才能给表名标上「支持主子表联查」。
  const templateItems = bare ? await templates() : [], tableItems = bare ? tables() : [];
  const suggestions = [...business, ...projections, ...cols, ...archiveItems, ...aliases, ...tableItems, ...templateItems, ...functions, ...snippets, ...keywords, ...(ctx.clause === "other" ? cteItems : []), ...actionItems(), ...(fieldsReady ? [] : [loadingItem])];
  return { suggestions: stale() ? [] : suggestions.length ? suggestions : connectionNotice(), incomplete: true };
}

/** 对外入口不变；出口统一计一次调用与各建议源曝光（提示行/加载中无标签，不计）。
 * 被取消的请求不计次：打字过程中 Monaco 频繁取消旧请求，计进去会把调用数虚增。 */
export async function provideSqlAssist(model: monaco.editor.ITextModel, position: monaco.Position, context: monaco.languages.CompletionContext, token: monaco.CancellationToken): Promise<monaco.languages.CompletionList> {
  const list = await provideSqlAssistInner(model, position, context, token);
  if (!token.isCancellationRequested) {
    recordAssistCall(context?.triggerKind === monaco.languages.CompletionTriggerKind.Invoke ? "invoke" : "auto");
    recordAssistOffers(list.suggestions as { ncforgeSource?: string }[]);
  }
  return list;
}
