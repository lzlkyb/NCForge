import { monaco } from "./monacoSetup";
import { tabIdOfModel } from "./sqlModels";
import { columnsOf, rtOf, sqlTabOf } from "./dbStore";
import { statementAt } from "./sqlSplit";
import { aliasMap, completionContext, SQL_KEYWORDS, tablesIn } from "./sqlComplete";

/**
 * SQL 编辑器的补全：表名（带 NC 中文名）、别名后的字段（带类型与中文名）、关键字。
 *
 * 字段优先问已连上的库（有中文名和主键，按表缓存），没连上就用本地表结构缓存。
 */

type Item = monaco.languages.CompletionItem;

async function columnItems(connId: string, table: string, range: monaco.IRange, rank: number): Promise<Item[]> {
  const K = monaco.languages.CompletionItemKind;
  const rt = rtOf(connId);
  let cols: { name: string; type: string; zh: string | null; pk: boolean }[] = [];
  if (rt.status === "connected") {
    try {
      cols = (await columnsOf(connId, table)).map((c) => ({ name: c.name, type: c.full, zh: c.zh, pk: c.pk }));
    } catch {
      cols = [];
    }
  }
  if (cols.length === 0) {
    cols = (rt.schema?.tables[table.toLowerCase()] ?? []).map(([name, type]) => ({ name, type, zh: null, pk: false }));
  }
  return cols.map((c, i) => ({
    label: { label: c.name.toLowerCase(), detail: ` ${c.type}${c.pk ? " · PK" : ""}`, description: c.zh ?? table.toLowerCase() },
    kind: c.pk ? K.Property : K.Field,
    insertText: c.name.toLowerCase(),
    range,
    sortText: `${rank}${String(i).padStart(4, "0")}`,
  }));
}

function tableItems(connId: string, range: monaco.IRange): Item[] {
  const K = monaco.languages.CompletionItemKind;
  const rt = rtOf(connId);
  const names = rt.ncNames ?? {};
  const list = rt.tables?.map((t) => ({ name: t.name, view: t.kind === "VIEW" })) ??
    Object.keys(rt.schema?.tables ?? {}).map((name) => ({ name, view: false }));
  return list.map((t) => {
    const lower = t.name.toLowerCase();
    return {
      label: { label: lower, description: names[lower] ?? (t.view ? "视图" : "") },
      kind: t.view ? K.Interface : K.Struct,
      insertText: lower,
      range,
      sortText: `5${lower}`,
    };
  });
}

let wired = false;

export function registerSqlProviders(): void {
  if (wired) return;
  wired = true;
  monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: ["."],
    provideCompletionItems: async (model, position) => {
      const tabId = tabIdOfModel(model);
      const connId = sqlTabOf(tabId)?.connId;
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const K = monaco.languages.CompletionItemKind;
      const text = model.getValue();
      const stmt = statementAt(text, model.getOffsetAt(position));
      const stmtText = stmt?.text ?? text;
      const before = model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column));
      const ctx = completionContext(before);
      const keywords: Item[] = SQL_KEYWORDS.map((k) => ({ label: k, kind: K.Keyword, insertText: k, range, sortText: `9${k}` }));
      if (!connId) return { suggestions: ctx.kind === "column" ? [] : keywords };

      if (ctx.kind === "column") {
        const table = aliasMap(stmtText).get(ctx.qualifier) ?? ctx.qualifier;
        return { suggestions: await columnItems(connId, table, range, 0) };
      }
      if (ctx.kind === "table") return { suggestions: tableItems(connId, range) };
      // 无前缀：语句里用到的表的字段排最前（最多前 3 张表），再是关键字与表名
      const used = tablesIn(stmtText).slice(0, 3);
      const cols = (await Promise.all(used.map((t, i) => columnItems(connId, t, range, i + 1)))).flat();
      return { suggestions: [...cols, ...keywords, ...tableItems(connId, range)] };
    },
  });
}
