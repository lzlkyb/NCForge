import { monaco } from "./monacoSetup";
import { connOf, rtOf, sqlColumnEpoch, sqlTabOf } from "./dbStore";
import { sqlAssistColumns as readAssistColumns } from "./sqlAssistColumns";
import { connectionKey } from "./dbResultContext";
import { tabIdOfModel } from "./sqlModels";
import { dialectOfSqlModel, sqlAnalysisOf } from "./monacoSql";
import { resolveSqlQualifier, sqlCtesAt, sqlScopeAt, sqlSourcesAt, type SqlSource } from "./sqlScope";
import { getSqlFormatPrefs } from "./sqlFormatPrefs";
import { getSqlTemplatesEnabled, snippetEscape, tableTemplates } from "./sqlTemplates";
import { billQueryRelations, billQueryTemplates, conditionQueryTemplates, completeQueryTemplates } from "./sqlBillTemplates";
import { sqlTableDescription } from "./sqlBillHint";
import { billJoinSpecs, billTableOf } from "./sqlBillJoin";
import { sqlActionsAt } from "./sqlAssistActions";
import { sqlPredicateContext } from "./sqlPredicateContext";
import { sqlPredicates } from "./sqlPredicates";
import { sqlTimePresets } from "./sqlTimePresets";
import { queryCheckChoices } from "./sqlQueryCheckAssist";
import { buildBillRelationChecks, buildIncomingDetailCountChecks } from "./sqlQueryChecks";
import { archiveExpansion, archiveProjectionAt, archiveRelations } from "./sqlArchiveExpansion";
import { completionContext, sqlIdentifier } from "./sqlCompletionContext";
import { sqlAssistSort, sqlMatchQuality, sqlSnippetText } from "./sqlAssistRanking";
import { sqlAssistFunctions, sqlAssistKeywords } from "./sqlAssistDialect";
import { sqlUsageKey, sqlUsageReason, sqlUsageScope } from "./sqlUsage";
import { filterSnippets, listSnippets } from "./dbSnippets";
import { clearSqlBusinessCache, peekSqlBusinessMetadata, readSqlBusinessMetadata, sqlConditionSuggestions, sqlEnumSuggestions, sqlJoinSuggestions, sqlRelatedQueries, type BusinessSuggestion } from "./sqlBusiness";
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
  const checks = !token.isCancellationRequested && queryCheckChoices(model, position);
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
  const prefix = model.getValue().slice(ctx.valueStart ?? start, offset).replace(/^['"`[]/, "");
  const range = monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(identifier?.end ?? offset));
  const waitBudget = context?.triggerKind === monaco.languages.CompletionTriggerKind.Invoke ? 500 : 120;
  const archiveDeadline = Date.now() + waitBudget;
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
  const visible = sources.filter(s => unique(s) && (ctx.clause !== "on" || analysis.tokens[s.declaration].start < offset));
  const qualifierText = (s: SqlSource) => s.aliasRef ?? (s.alias ? sqlIdentifier(s.alias, dialect) : s.nameRef ?? sqlIdentifier(s.name, dialect));
  // 光标不落在任何查询语句里 = 语句还没开始（空行、或刚敲完分号的新语句）。
  // 这是「先打表名、再补 select」的起点，也是唯一该把表名与整条查询模板端出来的位置；
  // 一旦进了 SELECT 投影 / WHERE，列表要留给字段。
  // 🔴 判据不能用 `analysis.scopes.length === 0`：脚本里前面写过语句就永远不为 0。
  const bare = !sqlScopeAt(analysis, offset);
  const tableList = rt?.tables ?? Object.keys(rt?.schema?.tables ?? {}).map(name => ({ name, kind: "TABLE" }));
  const tableNames = tableList.map(t => t.name);
  const tables = (): Item[] => {
    if (!connId || ctx.kind === "schema" && ctx.schema?.toLowerCase() !== schema.toLowerCase()) return [];
    const shadowed = new Set(ctes.map(c => sqlReferenceKey(c.name, c.nameRef, dialect)));
    return tableList.flatMap(t => {
      const name = normalized(t.name), zh = rt?.ncNames?.[name.toLowerCase()] ?? "", quality = match(name, zh);
      if (quality === 9) return [];
      const insertText = sqlIdentifier(sqlWordKind(name, dialect) === "identifier" ? name : t.name, dialect);
      if (shadowed.has(sqlReferenceKey(name, insertText, dialect))) return [];
      const key = sqlUsageKey(insertText), why = reason(key);
      return [{ label: { label: name, description: sqlTableDescription({ zh, view: t.kind === "VIEW", why, connId, scope, prefix, name, available: tableNames }) }, kind: t.kind === "VIEW" ? K.Interface : K.Struct,
        insertText, filterText: filter(name), range, sortText: sqlAssistSort(quality, 4, name, scope, key), command: command(key),
        documentation: { value: `${schema ? schema + "." : ""}${name}${zh ? "\n\n" + zh : ""}${why ? "\n\n推荐依据：" + why : ""}` } }];
    });
  };
  const cteItems: Item[] = ctes.filter(c => match(c.name) < 9).map(c => ({ label: { label: c.name, description: "当前查询 CTE" }, kind: K.Interface, insertText: c.nameRef ?? sqlIdentifier(c.name, dialect), filterText: filter(c.name), range, sortText: sqlAssistSort(match(c.name), 0, c.name) }));
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
    if (!connId || !prefix || !getSqlTemplatesEnabled()) return [];
    const previous = analysis.tokens.filter(t => t.end <= start && !["space", "comment", "hint"].includes(t.kind)).pop();
    if (previous && previous.text !== ";") return [];
    const next = analysis.tokens.find(t => t.start >= (identifier?.end ?? offset) && !["space", "comment", "hint"].includes(t.kind));
    if (next && next.text !== ";") return [];
    const typed = prefix.toLowerCase();
    const named = tableList.map(t => ({ raw: t.name, name: normalized(t.name) }));
    const exact = named.filter(t => t.name.toLowerCase() === typed);
    const chineseExact = named.filter(t => rt?.ncNames?.[t.name.toLowerCase()]?.toLowerCase() === typed);
    const candidates = exact.length ? exact : chineseExact.length ? chineseExact : named.filter(t => t.name.toLowerCase().startsWith(typed) || match(t.name, rt?.ncNames?.[t.name.toLowerCase()]) === 2);
    // 多条命中就不猜：猜错一次就要用户撤销一整条语句
    if (candidates.length !== 1) return [];
    const { raw, name } = candidates[0];
    const insertText = sqlIdentifier(sqlWordKind(name, dialect) === "identifier" ? name : raw, dialect);
    const head = sqlAssistSort(match(name, rt?.ncNames?.[name.toLowerCase()]), 4, name);
    const upper = getSqlFormatPrefs().keywordCase !== "lower";
    const items: Item[] = tableTemplates(insertText, upper, dialect).map((tpl, i) => ({
      label: { label: tpl.label, description: tpl.hint }, kind: K.Snippet, insertText: next ? tpl.insertText.replace(/;\$0$/, "$0") : tpl.insertText,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      filterText: filter(name), range, sortText: i === 0 ? `!${head}` : `${head}~${i}`,
      preselect: i === 0,
      documentation: { value: `\`\`\`sql\n${tpl.label};\n\`\`\`` },
    }));
    if (!scope || rt?.status !== "connected" || !/^[a-z_][\w$#]*$/i.test(raw) || mixed(raw) || insertText !== name || dialect !== "plsql") return items;
    const deadline = Date.now() + waitBudget;
    const [metadata, rootColumns] = await Promise.all([
      early(readSqlBusinessMetadata(connId, scope, name, metadataCurrent), null, waitBudget),
      early(readColumns({ table: name, tableRef: name, name, declaration: 0 }), [], waitBudget),
    ]);
    if (stale()) return items;
    // Keep one completion within its original time budget and bound cold metadata reads.
    const relations = rootColumns.length
      ? billQueryRelations(name, tableList.map(t => t.name), metadata).slice(0, 8) : [];
    const billColumns = await Promise.all([...new Set(relations.map(r => r.table))].map(async table =>
      [table, await early(readColumns({ table, tableRef: table, name: table, declaration: 0 }), [], Math.max(0, deadline - Date.now()))] as const));
    if (stale()) return items;
    const columns = { [name]: rootColumns, ...Object.fromEntries(billColumns) };
    const checkContext = { tables: tableList.map(t => t.name), columns, names: rt.ncNames, schema, upper };
    const checkTemplates = [...buildBillRelationChecks(name, relations, checkContext), ...buildIncomingDetailCountChecks(name, metadata, checkContext)]
      .map(t => ({ ...t, insertText: snippetEscape(t.sql).slice(0, -1) + "$0;", pickField: false }));
    const queries = [...conditionQueryTemplates(name, rt.ncNames ?? {}, columns, relations, upper, dialect), ...billQueryTemplates(name, rt.ncNames ?? {}, columns, relations, upper, dialect), ...completeQueryTemplates(name, rt.ncNames ?? {}, columns, relations, upper), ...checkTemplates];
    const bills: Item[] = queries.map((tpl, i) => ({
      label: { label: tpl.label, description: tpl.hint }, kind: K.Snippet,
      insertText: next ? tpl.insertText.slice(0, -1) : tpl.insertText,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      filterText: filter(name), range, sortText: `${head}~8${String(i).padStart(2, "0")}`,
      command: tpl.pickField ? { id: "editor.action.triggerSuggest", title: "选择条件字段" } : undefined,
      documentation: { value: `${tpl.hint}\n\n\`\`\`sql\n${tpl.sql}\n\`\`\`` },
    }));
    const related = metadata ? sqlRelatedQueries(metadata, rt.ncNames ?? {}, upper, dialect) : [];
    return [...items, ...bills, ...related.map((item, i): Item => ({
      label: { label: item.label, description: item.source },
      kind: K.Snippet, filterText: filter(name), range, sortText: `${head}~9${i}`,
      insertText: next ? item.insertText.slice(0, -1) : item.insertText,
      documentation: { value: `${item.source}\n\n\`\`\`sql\n${item.insertText}\n\`\`\`` },
    }))];
  };
  /** 光标前词精确命中的表；半截前缀、或必须加引号才成立的标识符返回空。 */
  const billHit = () => billTableOf(prefix, tableNames, rt?.ncNames, name => !mixed(name) && sqlIdentifier(name, dialect) === name);
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
    if (name) await early(readSqlBusinessMetadata(connId, scope, name, metadataCurrent), null, waitBudget);
  };
  /**
   * 表名末尾的「接上子表」。插入点固定在光标处，所以要求光标正好落在表名末尾 ——
   * 光标在词中间时空 range 会把 JOIN 塞进标识符里。
   */
  const joinSnippets = (): Item[] => {
    if (!connId || !scope || dialect !== "plsql" || identifier?.end !== offset || !getSqlTemplatesEnabled()) return [];
    const name = billHit();
    if (!name) return [];
    return billJoinSpecs(name, tableNames, peekSqlBusinessMetadata(connId, scope, name)).map((spec, i) => ({
      label: { label: `LEFT JOIN ${spec.table}`, description: `主从表 · ${spec.source}` }, kind: K.Snippet,
      insertText: spec.sql, filterText: filter(name), range: monaco.Range.fromPositions(position, position),
      sortText: `${sqlAssistSort(match(name), 5, "join" + i)}`, documentation: { value: `\`\`\`sql\nSELECT * FROM ${name}${spec.sql}\n\`\`\`` },
    }));
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
    return meta ? billJoinSpecs(name, tableNames, meta).length : 0;
  };
  /**
   * 位置允许的动作，作为列表末尾的可选条目。
   *
   * 这些能力原先只有「Ctrl+. 或灯泡」一条路（而灯泡因为 `glyphMargin` 是关着的
   * 根本没画出来），用户不知道有。放进补全列表，按 Ctrl+空格 就能看见
   * 「这儿还能做什么」。选中不插入任何字符（空 range + 空 insertText），
   * 只唤起同一个 CodeAction 菜单——不复制实现，避免两处判定走偏。
   */
  const actionItems = (name: string): Item[] => name ? sqlActionsAt({
    plsql: dialect === "plsql", templatesEnabled: getSqlTemplatesEnabled(), bare,
    table: name, relations: relationCount(name),
  }).map((action, i): Item => ({
    label: { label: action.title, description: `动作 · ${action.detail}` }, kind: K.Snippet,
    insertText: "", filterText: prefix || action.title, range: monaco.Range.fromPositions(position, position),
    sortText: `\ufffe${String(i).padStart(2, "0")}`, command: { id: "ncforge.sql.quickFix", title: action.title },
    documentation: { value: action.detail },
  })) : [];
  if (ctx.kind === "none" || stale()) return { suggestions: [] };
  if (ctx.kind === "table") {
    await warmBillHints();
    // 多了这一次 await，模型可能在等待期间被改过；此时 range/prefix 都已过期。
    if (stale()) return { suggestions: [] };
    const items = [...cteItems, ...tables(), ...joinSnippets(), ...actionItems(billHit())];
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
  const fromColumns = (source: SqlSource, cols: ColumnInfo[], qualified: boolean): Item[] => cols.flatMap(c => {
    const name = normalized(c.name), quality = match(name, c.zh ?? "");
    if (quality === 9) return [];
    qualified ||= predicate?.kind === "field" && ctx.kind !== "column";
    const q = qualifierText(source), insertText = `${qualified ? q + "." : ""}${sqlIdentifier(sqlWordKind(name, dialect) === "identifier" ? name : c.name, dialect)}`;
    const key = source.table ? sqlUsageKey(objectKey(source), name, ctx.clause) : undefined, why = key ? reason(key) : "";
    const base: Item = { label: { label: qualified ? `${source.alias ?? source.name}.${name}` : name, detail: ` ${c.full}${c.pk ? " · PK" : ""}`, description: [c.zh, source.tableRef || source.name, why].filter(Boolean).join(" · ") }, kind: c.pk ? K.Property : K.Field,
      insertText, filterText: filter(name), range, sortText: sqlAssistSort(quality, 1, insertText, scope, key, ctx.assigned.includes(name)), command: key ? command(key) : undefined,
      documentation: { value: `${source.tableRef ?? source.name}.${name}\n\n${c.full}${c.zh ? " · " + c.zh : ""}${why ? "\n\n" + why : ""}` } };
    if (predicate?.kind !== "field") return [base];
    // A typed alias stays outside the replacement range, but repeated range operands still need it.
    const conditionPrefix = ctx.kind === "column" ? q + "." : "";
    const options = [...sqlPredicates(conditionPrefix + insertText, c.full || c.type || "", dialect, getSqlFormatPrefs().keywordCase !== "lower"), ...sqlTimePresets(conditionPrefix + insertText, c.full || c.type || "", dialect, getSqlFormatPrefs().keywordCase !== "lower")];
    const exact = !!prefix && (prefix.toLowerCase() === name.toLowerCase() || prefix === c.zh);
    const selected = options.filter(p => (exact || p.operator === "=") && (!predicate.negated || p.operator !== "RANGE" && !p.operator.startsWith("TIME_")));
    const items = selected.map((p, i): Item => ({ ...base, kind: K.Snippet,
      label: { label: `${qualified ? q + "." : ""}${name} · ${p.label}`, description: [c.zh, source.tableRef || source.name, p.hint].filter(Boolean).join(" · ") },
      insertText: p.insertText.slice(snippetEscape(conditionPrefix).length), insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      sortText: `${base.sortText}~${String(i).padStart(2, "0")}`, documentation: { value: `${source.tableRef ?? source.name}.${name}\n\n${p.hint}\n\n${p.label} · ${c.full}` },
    }));
    return items.length ? items : [base];
  });
  if (predicate?.kind === "operator") {
    const cols = await early(readColumns(predicate.source), null, waitBudget);
    const fieldKey = sqlReferenceKey(predicate.field, predicate.fieldRef, dialect);
    const columns = cols?.filter(c => sqlReferenceKey(normalized(c.name), mixed(c.name) ? sqlIdentifier(c.name, dialect) : undefined, dialect) === fieldKey) ?? [];
    const column = columns.length === 1 ? columns[0] : undefined;
    const id = `${qualifierText(predicate.source)}.${predicate.fieldRef}`;
    const options = column ? [...sqlPredicates(id, column.full || column.type || "", dialect, getSqlFormatPrefs().keywordCase !== "lower"), ...sqlTimePresets(id, column.full || column.type || "", dialect, getSqlFormatPrefs().keywordCase !== "lower")] : [];
    return { suggestions: stale() ? [] : cols === null ? [loadingItem] : options.filter(p => match(p.operator, p.label) < 9 && (!predicate.negated || p.operator !== "RANGE" && !p.operator.startsWith("TIME_"))).map((p, i) => ({
      label: { label: `${p.operator.startsWith("TIME_") ? "时间快捷" : p.operator === "RANGE" ? ">= … AND < …" : p.operator} · ${p.label}`, description: p.hint }, kind: K.Snippet,
      insertText: p.suffix, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, filterText: filter(p.label),
      range: monaco.Range.fromPositions(model.getPositionAt(predicate.start), model.getPositionAt(predicate.end)), sortText: String(i).padStart(2, "0"),
    })), incomplete: true };
  }
  const derived = (source: SqlSource, qualified: boolean): Item[] => (source.columns ?? []).filter(name => match(name) < 9).map(name => ({ label: { label: qualified ? `${source.alias ?? source.name}.${name}` : name, description: "查询输出 · " + (source.alias ?? source.name) }, kind: K.Field,
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
    const relations = fields.flatMap(field => archiveRelations(source, field.name, tableList.map(t => t.name), meta).map(relation => ({ field, relation }))).slice(0, 4);
    const items = await Promise.all(relations.map(async ({ field, relation }): Promise<Item | undefined> => {
      const table = relation.target.toLowerCase(), targetColumns = await early(readColumns({ name: table, table, tableRef: table, declaration: 0 }), [], remaining());
      if (stale()) return;
      const expansion = archiveExpansion(analysis, projection, source, field, columns, relation, targetColumns, getSqlFormatPrefs().keywordCase !== "lower");
      if (!expansion) return;
      const key = sqlUsageKey(objectKey(source), normalized(field.name), "select");
      return { label: { label: `${qualifierText(source)}.${normalized(field.name)} · 展开档案编码和名称`, description: `${rt.ncNames?.[table] || table} · ${relation.kind}` },
        kind: K.Snippet, insertText: expansion.insertText, filterText: model.getValue().slice(projection.start, offset),
        range: monaco.Range.fromPositions(model.getPositionAt(projection.start), model.getPositionAt(projection.end)),
        additionalTextEdits: expansion.join ? [{ range: monaco.Range.fromPositions(model.getPositionAt(expansion.join.offset), model.getPositionAt(expansion.join.offset)), text: expansion.join.text }] : undefined,
        sortText: `${sqlAssistSort(match(normalized(field.name), field.zh ?? ""), 1, normalized(field.name))}~archive`, command: command(key),
        documentation: { value: `保留引用主键，增加 ${table}.${expansion.code} 与 ${table}.${expansion.name}。\n\n已确认完整目标主键，LEFT JOIN 保留原行数。\n\n\`\`\`sql\n${expansion.insertText}${expansion.join?.text ?? ""}\n\`\`\`` } };
    }));
    return items.filter((item): item is Item => !!item);
  };
  if (ctx.kind === "column") {
    const resolved = resolveSqlQualifier(analysis, offset, ctx.qualifier!, ctx.qualifierRef);
    const source = resolved && ctx.clause === "on" && analysis.tokens[resolved.declaration].start >= offset ? undefined : resolved;
    const columns = source?.table ? await early(readColumns(source), null, waitBudget) : undefined;
    const suggestions = !source ? [] : columns === null ? [loadingItem] : columns ? [...fromColumns(source, columns, false), ...await archives(source, columns)] : derived(source, false);
    return { suggestions: stale() ? [] : suggestions.length ? suggestions : connectionNotice(), incomplete: true };
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
  const archiveItems = (await Promise.all(visible.slice(0, 4).map(s => archives(s, loaded.get(s) ?? [])))).flat();
  const aliases: Item[] = visible.filter(s => match(s.alias ?? s.name) < 9).map(s => ({ label: { label: s.alias ?? s.name, description: `来源 ${s.tableRef ?? "查询输出"} · 输入 . 查看字段` }, kind: K.Variable, insertText: qualifierText(s), filterText: filter(s.alias ?? s.name), range, sortText: sqlAssistSort(match(s.alias ?? s.name), 3, s.name) }));
  const functions: Item[] = sqlAssistFunctions(dialect).filter(f => match(f.name) < 9 && !["set", "order", "group"].includes(ctx.clause)).map(f => ({ label: { label: f.name, detail: `(${f.args.join(", ")})`, description: f.description }, kind: K.Function,
    insertText: `${f.name}(${f.args.map((arg, i) => `\${${i + 1}:${arg}}`).join(", ")})`, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, filterText: filter(f.name), range, sortText: sqlAssistSort(match(f.name), 6, f.name), documentation: f.description }));
  const keywords: Item[] = sqlAssistKeywords(ctx.clause, dialect).filter(k => match(k) < 9).map(k => ({ label: k, kind: K.Keyword, insertText: k, filterText: filter(k), range, sortText: sqlAssistSort(match(k), 7, k) }));
  const snippets: Item[] = prefix ? filterSnippets(listSnippets(connId ?? null), prefix).map(s => ({ label: { label: s.name, description: "已保存 SQL 片段" }, kind: K.Snippet, insertText: sqlSnippetText(s.sql), insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, filterText: filter(s.name), range, sortText: sqlAssistSort(match(s.name, s.sql), 5, s.name), documentation: { value: s.sql } })) : [];
  const projections: Item[] = ctx.projections.filter(name => match(name) < 9).map(name => ({ label: { label: name, description: "当前 SELECT 输出" }, kind: K.Field, insertText: sqlIdentifier(name, dialect), filterText: filter(name), range, sortText: sqlAssistSort(match(name), 0, name) }));
  const business: Item[] = [];
  // Later JOIN tables exist in the parsed query, but are unavailable in this ON condition.
  const onSources = physical.filter(s => analysis.tokens[s.declaration].start < offset);
  if (predicate?.kind === "field" && !predicate.negated && ctx.clause === "on" && onSources.length > 1) {
    const source = onSources[onSources.length - 1], meta = await metadata(source);
    const verifiedSources = onSources.map(s => ({ ...s, table: s.table! }));
    if (meta) business.push(...sqlJoinSuggestions({ ...meta, schema }, verifiedSources, source.alias ?? source.name, dialect).filter(s => !prefix || match(s.label, s.insertText) < 9).map(s => businessItem(s)));
    if (scope) business.push(...sqlHistoricalJoinSuggestions(scope, verifiedSources, Object.fromEntries(onSources.map(s => [s.tableRef ?? s.table!, (loaded.get(s) ?? []).map(c => ({ name: c.name, type: c.full }))])), dialect).filter(s => !prefix || match(s.label, s.insertText) < 9).map(s => ({ ...businessItem(s), sortText: `${match(s.label, s.insertText)}01${s.label}` })));
  }
  if (predicate?.kind === "field" && ctx.clause === "where") for (const source of physical) business.push(...sqlConditionSuggestions({ ...source, table: source.table! }, (loaded.get(source) ?? []).map(c => ({ name: c.name, type: c.full })), dialect).filter(s => !prefix || match(s.label, s.insertText) < 9).map(s => businessItem(s)));
  // 语句还没开始时，表名才是这个位置最该出现的东西。`any` 分支其余内容（字段、别名、
  // 函数、关键字）在这个位置基本都用不上，所以表名与模板排在最前面。
  // 已知取舍：超过 `SQL_ANALYSIS_LIMIT`（200k 字符）或 512 条语句的脚本里 `analyzeSql`
  // 会放弃建 scope，此时 `bare` 对所有位置都为真——但那时整条链路本来就没有上下文可用，
  // 多出来的表名仍然按输入的前缀过滤，不会误导。
  // 先算模板：`templates()` 读到的业务关系会落进 `peekSqlBusinessMetadata` 的同步副本，
  // 紧接着的 `tables()` 才能给表名标上「支持主子表联查」。
  const templateItems = bare ? await templates() : [], tableItems = bare ? tables() : [];
  const suggestions = [...business, ...projections, ...cols, ...archiveItems, ...aliases, ...tableItems, ...templateItems, ...functions, ...snippets, ...keywords, ...(ctx.clause === "other" ? cteItems : []), ...actionItems(tableAtCaret()), ...(fieldsReady ? [] : [loadingItem])];
  return { suggestions: stale() ? [] : suggestions.length ? suggestions : connectionNotice(), incomplete: true };
}
