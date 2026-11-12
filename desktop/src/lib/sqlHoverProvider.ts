import { monaco } from "./monacoSetup";
import { tabIdOfModel } from "./sqlModels";
import { columnsOf, rtOf, sqlTabOf } from "./dbStore";
import { SQL_LANGUAGE_IDS, sqlAnalysisOf } from "./monacoSql";
import { resolveSqlQualifier, sqlSourcesAt, type SqlAnalysis, type SqlSource } from "./sqlScope";
import { sqlName } from "./sqlLex";
import { columnHover, keywordHover, tableHover } from "./sqlHoverText";

/**
 * SQL 编辑器的悬停卡片：表名给中文名/类型/字段数，字段给类型/主键/可空/注释，
 * 关键字给一句人话。
 *
 * 🔴 只读**已有**的元数据：
 * - 表的字段数来自 `rt.schema`（本地缓存），不额外打 IPC；
 * - 字段信息走 `columnsOf`，它按连接 + 表缓存 Promise——第一次悬停会拉一次字段，
 *   之后同一个会话里都是缓存。表清单里没有这个名字时**不拉**：否则把拼错的表名
 *   悬停一下就是一次必然失败的 IPC。
 */
export function registerSqlHoverProviders(): void {
  for (const language of SQL_LANGUAGE_IDS) monaco.languages.registerHoverProvider(language, { provideHover });
}

/** 光标所在 token 对应的数据来源（表 / 别名 / CTE）。 */
function sourceOf(analysis: SqlAnalysis, offset: number, index: number): SqlSource | undefined {
  const own = analysis.scopes.flatMap(s => s.sources).find(s => s.declaration === index);
  if (own) return own;
  const tokens = analysis.tokens;
  let prev = index - 1;
  while (prev >= 0 && ["space", "comment", "hint"].includes(tokens[prev].kind)) prev--;
  if (prev >= 0 && tokens[prev].text === ".") {
    let q = prev - 1;
    while (q >= 0 && ["space", "comment", "hint"].includes(tokens[q].kind)) q--;
    if (q >= 0) return resolveSqlQualifier(analysis, offset, sqlName(tokens[q]), tokens[q].text);
  }
  const sources = sqlSourcesAt(analysis, offset);
  return sources.length === 1 ? sources[0] : undefined;
}

/** 本地结构缓存里的列数；`null` = 这张表的结构没缓存过。 */
function cachedColumns(connId: string, table: string): number | null {
  const tables = rtOf(connId).schema?.tables;
  if (!tables) return null;
  const key = Object.keys(tables).find(k => k.toLowerCase() === table.toLowerCase());
  return key ? tables[key].length : null;
}

async function provideHover(model: monaco.editor.ITextModel, position: monaco.Position): Promise<monaco.languages.Hover | null> {
  const tab = sqlTabOf(tabIdOfModel(model));
  const connId = tab?.connId;
  if (!connId) return null;
  const analysis = sqlAnalysisOf(model);
  const offset = model.getOffsetAt(position);
  // 光标可能停在词的边界上（Monaco 传的是 1-based 位置），两侧都算命中
  const index = analysis.tokens.findIndex(t => t.start <= offset && t.end >= offset);
  if (index < 0) return null;
  const token = analysis.tokens[index];
  if (["space", "comment", "hint", "string", "parameter"].includes(token.kind)) return null;
  const range = monaco.Range.fromPositions(model.getPositionAt(token.start), model.getPositionAt(token.end));
  const wrap = (value: string): monaco.languages.Hover => ({ range, contents: [{ value }] });

  const role = analysis.roles.get(index);
  if (token.kind === "keyword") {
    const text = keywordHover(token.text);
    return text ? wrap(text) : null;
  }
  if (role === "table") {
    const name = sqlName(token);
    const rt = rtOf(connId);
    const columns = cachedColumns(connId, name);
    return wrap(tableHover({
      name,
      zh: rt.ncNames?.[name.toLowerCase()],
      kind: rt.tables?.find(t => t.name.toLowerCase() === name.toLowerCase())?.kind,
      columns: columns ?? undefined,
      loaded: columns !== null,
    }));
  }
  if (role !== "column") return null;

  const source = sourceOf(analysis, offset, index);
  const table = source?.table;
  // 临时结果（CTE / 子查询）没有物理表可查：说清楚，别让用户以为查不到字段
  if (!table) return source ? wrap(`**${sqlName(token)}** 来自查询里定义的临时结果，字段要回它的 \`select\` 看`) : null;
  const rt = rtOf(connId);
  if (rt.tables && !rt.tables.some(t => t.name.toLowerCase() === table.toLowerCase())) return null;
  try {
    const columns = await columnsOf(connId, table);
    if (model.isDisposed()) return null;
    const column = columns.find(c => c.name.toLowerCase() === sqlName(token).toLowerCase());
    return column ? wrap(columnHover(column, table)) : null;
  } catch {
    // 读字段失败不弹错误卡片：悬停不是一次显式操作，弹红字只会吓人
    return null;
  }
}
