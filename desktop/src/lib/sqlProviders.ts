import { monaco } from "./monacoSetup";
import { tabIdOfModel } from "./sqlModels";
import { sqlTabOf } from "./dbStore";
import { pickStatement } from "./sqlSplit";
import { statementsOf } from "./sqlStmtCache";
import { SQL_LANGUAGE_IDS, sqlAnalysisOf } from "./monacoSql";
import { sqlCompletionAt } from "./sqlScope";
import { provideSqlAssist } from "./sqlAssistProvider";
import { callContext, hasOverloads, parameterLabel, pickOverload, signatureLabel } from "./sqlSignature";
import { procArguments } from "./sqlProcArgs";
import { scopedTableLinks } from "./sqlScopeLinks";
import { openTable } from "./dbActions";
import { registerSqlHoverProviders } from "./sqlHoverProvider";

/**
 * SQL 编辑器的补全：表名（带 NC 中文名）、别名后的字段（带类型与中文名）、关键字。
 *
 * 字段优先问已连上的库（有中文名和主键，按表缓存），没连上就用本地表结构缓存。
 *
 * 另外给表名挂上 Ctrl+点击跳转（对标 PL/SQL Developer）：点 `from bd_material m` 里的
 * 表名或别名，直接开这张表的 DDL 页。走 LinkProvider 而不是 DefinitionProvider——
 * 后者的 Ctrl+悬停会去 `createModelReference` 取目标行做预览，而我们的目标是数据库
 * 标签页、根本没有对应的 text model，装饰反而挂不上（还会甩一条未处理的 rejection）。
 */

let wired = false;

/** 表名链接的自定义 scheme：`ncforge-table:/<连接 id>/<表名>`。 */
const TABLE_SCHEME = "ncforge-table";
/** 一条语句里最多挂多少个链接；几千个装饰会把编辑器拖慢，超出部分不跳。 */
const MAX_LINKS = 2000;

function tableUri(connId: string, table: string): monaco.Uri {
  return monaco.Uri.from({
    scheme: TABLE_SCHEME,
    path: `/${encodeURIComponent(connId)}/${encodeURIComponent(table)}`,
  });
}

/** 链接被点开：解析出连接与表名，开它的 DDL 页。认不出的 scheme 交还给下一个 opener。 */
function openTableUri(resource: monaco.Uri): boolean {
  if (resource.scheme !== TABLE_SCHEME) return false;
  const [connId, table] = resource.path.replace(/^\//, "").split("/").map(decodeURIComponent);
  if (!connId || !table) return false;
  void openTable(connId, table, "ddl");
  return true;
}

export function registerSqlProviders(): void {
  if (wired) return;
  wired = true;
  for (const language of SQL_LANGUAGE_IDS) {
  monaco.languages.registerCompletionItemProvider(language, {
    triggerCharacters: [".", "="],
    provideCompletionItems: provideSqlAssist,
  });

  // 签名帮助：敲 `proc(` 或 `proc(a, ` 时列出参数（`all_arguments`）。
  //
  // 查不到同名过程就返回 null、什么都不弹——用户可能在写表函数、自己定义的过程，
  // 或者名字敲错了一半；这时候弹一个空签名比不弹更打断。
  // 只取**当前语句内**光标前的文本：长脚本里没必要为一次按键扫全文。
  monaco.languages.registerSignatureHelpProvider(language, {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    provideSignatureHelp: async (model, position) => {
      const connId = sqlTabOf(tabIdOfModel(model))?.connId;
      if (!connId) return null;
      const offset = model.getOffsetAt(position);
      if (sqlCompletionAt(sqlAnalysisOf(model), offset).kind === "none") return null;
      const stmt = pickStatement(statementsOf(model), offset);
      const before = stmt
        ? stmt.text.slice(0, offset - stmt.start)
        : model.getValue().slice(0, offset);
      const ctx = callContext(before);
      if (!ctx) return null;
      const data = await procArguments(connId, ctx.name);
      if (!hasOverloads(data)) return null;
      const chosen = pickOverload(data.overloads, ctx.argIndex);
      if (!chosen) return null;
      const shortName = ctx.name.split(".").pop() ?? ctx.name;
      return {
        value: {
          signatures: data.overloads.map((o) => ({
            label: signatureLabel(shortName, o),
            documentation: o.returns ? `函数，返回 ${o.returns}` : undefined,
            parameters: o.args.map((a) => ({
              label: parameterLabel(a),
              documentation: a.defaulted ? "有默认值，可省略" : undefined,
            })),
          })),
          activeSignature: data.overloads.indexOf(chosen),
          // 用户多写了参数时夹到最后一个，别让高亮落到不存在的下标上
          activeParameter: Math.min(ctx.argIndex, Math.max(0, chosen.args.length - 1)),
        },
        dispose: () => {},
      };
    },
  });

  // 表名链接：Ctrl+悬停出现下划线，Ctrl+点击开 DDL；Ctrl+点击表名以外的地方不弹任何东西
  monaco.languages.registerLinkProvider(language, {
    provideLinks: (model) => {
      const connId = sqlTabOf(tabIdOfModel(model))?.connId;
      if (!connId) return null;
      const links = scopedTableLinks(sqlAnalysisOf(model))
        .slice(0, MAX_LINKS)
        .map((l) => ({
          range: monaco.Range.fromPositions(model.getPositionAt(l.start), model.getPositionAt(l.end)),
          url: tableUri(connId, l.table),
          tooltip: `查看 ${l.table} 的 DDL`,
        }));
      return links.length > 0 ? { links } : null;
    },
  });
  }
  // 悬停卡片与补全/链接同一套词法分析：表名与字段用的是同一个 scope 结果，不会互相矛盾。
  registerSqlHoverProviders();
  monaco.editor.registerLinkOpener({ open: openTableUri });
}
