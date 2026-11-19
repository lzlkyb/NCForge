/**
 * SQL 编辑器里的行内提示：**长在代码上，不用记快捷键**。
 *
 * 两件事：
 *
 * 1. `FROM po_order` 的表名后面挂一枚可点的小 chip（「主子表联查」）。
 *    点它等于把光标放回表名末尾再开 CodeAction 菜单——判定与实现都在原来的
 *    provider 里，这里只负责「让人看见入口」。点 chip 不抢焦点（`mousedown`
 *    被拦下），否则 CodeAction 找不到当前编辑器。
 *
 * 2. LEFT JOIN 后写在 WHERE 里的关联条件，行尾补一句人话
 *    （「排除无匹配主表行 · Alt+Enter」）。只在**光标所在那一行**出现：
 *    整篇都挂行尾说明会盖住代码，而这个提示本来就是「现在这一条有问题」。
 *
 * 🔴 两个前提都是「同步快照有才说话」：没读到业务关系就不显示 chip，
 * 说了「支持联查」却点不动比不标更糟。快照没有时光标停住 400ms 读一次，
 * 同一张表只读一次。
 */
import { monaco } from "./monacoSetup";
import { connOf, rtOf, sqlTabOf } from "./dbStore";
import { connectionKey } from "./dbResultContext";
import { tabIdOfModel } from "./sqlModels";
import { dialectOfSqlModel, sqlAnalysisOf } from "./monacoSql";
import { sqlUsageScope } from "./sqlUsage";
import { sqlJoinMeanings, type JoinMeaning } from "./sqlJoinMeaning";
import { billLinkHint } from "./sqlBillHint";
import { peekSqlBusinessMetadata, readSqlBusinessMetadata } from "./sqlBusiness";
import { getSqlTemplatesEnabled } from "./sqlTemplates";
import { sqlWildcardAt } from "./sqlScope";
import { verifiedSqlSource } from "./sqlAssistLearning";
import { sqlEditorSelectionActions } from "./sqlSelectionAssist";

type Editor = monaco.editor.IStandaloneCodeEditor;

export function wireSqlAssistGhost(editor: Editor): monaco.IDisposable {
  let disposed = false, warmTimer: ReturnType<typeof setTimeout> | undefined, lensTimer: ReturnType<typeof setTimeout> | undefined;
  let position: monaco.editor.IContentWidgetPosition | null = null;
  /** 已经试过读取的表：读不到就不反复读。 */
  const warmed = new Set<string>();
  /** 关系提示的正文按 model 版本缓存，光标移动时只做一次查找。 */
  let meanings: { version: number; list: JoinMeaning[] } | null = null;

  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "ncforge-sql-chip";
  chip.hidden = true;
  // 点 chip 不能把焦点从编辑器抢走，否则 CodeAction / editor action 找不到当前编辑器。
  chip.addEventListener("mousedown", event => event.preventDefault());
  let chipRun: (() => void) | null = null;
  chip.addEventListener("click", () => { if (!disposed) chipRun?.(); });
  const widget: monaco.editor.IContentWidget = {
    getId: () => "ncforge.sql.billChip",
    getDomNode: () => chip,
    getPosition: () => position,
  };
  editor.addContentWidget(widget);
  const lens = editor.createDecorationsCollection();

  /** 在某个 token 的末尾挂一枚 chip。同一枚按钮复用于所有入口，位置与动作随时换。 */
  const showChip = (model: monaco.editor.ITextModel, end: number, text: string, title: string, run: () => void, keepSelection = false) => {
    chip.textContent = text;
    chip.title = title;
    chipRun = () => {
      if (disposed || editor.getModel() !== model) return;
      if (!keepSelection) editor.setPosition(model.getPositionAt(end));
      editor.focus(); run();
    };
    chip.hidden = false;
    position = { position: model.getPositionAt(end), preference: [monaco.editor.ContentWidgetPositionPreference.EXACT] };
    editor.layoutContentWidget(widget);
  };

  const hideChip = () => {
    if (!position) return;
    position = null; chipRun = null; chip.hidden = true;
    editor.layoutContentWidget(widget);
  };

  const refreshChip = () => {
    clearTimeout(warmTimer);
    if (disposed) return;
    const model = editor.getModel(), caret = editor.getPosition();
    if (!model || !caret) return hideChip();
    const tab = sqlTabOf(tabIdOfModel(model)), connId = tab?.connId, rt = connId ? rtOf(connId) : null;
    if (!connId || !rt || rt.status !== "connected") return hideChip();
    const selection = editor.getSelection();
    if (selection && !selection.isEmpty()) {
      const selected = sqlEditorSelectionActions(editor);
      if (!selected?.actions.length) return hideChip();
      const line = model.getPositionAt(selected.end).lineNumber;
      return showChip(model, model.getOffsetAt({ lineNumber: line, column: model.getLineMaxColumn(line) }), "选区操作 · Alt+Enter",
        selected.actions.map(action => action.title).join("\n"), () => editor.trigger("sql-ghost", "editor.action.quickFix", {}), true);
    }
    if (dialectOfSqlModel(model) !== "plsql") return hideChip();
    const schema = rt.currentSchema ?? rt.info?.schema ?? "";
    const analysis = sqlAnalysisOf(model), offset = model.getOffsetAt(caret);
    // ① `SELECT *` 上的展开入口。与「查询与条件模板」开关无关：展开字段不是模板，
    //    而它原先只在右键菜单里，用户根本撞不到。
    const wildcard = sqlWildcardAt(analysis, offset);
    const verified = wildcard?.source && verifiedSqlSource(connId, wildcard.source);
    if (wildcard && verified && !verified.quoted) {
      return showChip(model, analysis.tokens[wildcard.token].end, "展开字段",
        "把 * 展开成字段列表（带中文名）· Ctrl+空格", () => editor.trigger("sql-ghost", "editor.action.triggerSuggest", {}));
    }
    // 下面两条都依赖业务关系快照，归模板开关管：关掉模板就别再读库。
    if (!getSqlTemplatesEnabled()) return hideChip();
    // ② 只认「光标正压在某张表的声明名上」这一种位置：别名、字段、CTE 都不挂。
    const index = analysis.tokens.findIndex(t => t.start <= offset && t.end >= offset && ["identifier", "quoted"].includes(t.kind));
    if (index < 0) return hideChip();
    const source = analysis.scopes.flatMap(s => s.sources).find(s => s.declaration === index);
    const table = source?.table ?? "";
    if (!source || !table) return hideChip();
    if (source.schema && source.schema.toLowerCase() !== schema.toLowerCase()) return hideChip();
    const scopeKey = sqlUsageScope(connectionKey(connOf(connId)), schema), available = (rt.tables ?? []).map(t => t.name);
    const hint = billLinkHint(connId, scopeKey, table, available);
    if (!hint) {
      // 快照里还没有这张表的关系：光标在这儿停住再读一次，读到了自己会重画。
      const key = `${connId}|${table}`;
      if (peekSqlBusinessMetadata(connId, scopeKey, table) || warmed.has(key)) return hideChip();
      warmTimer = setTimeout(() => {
        warmed.add(key);
        void readSqlBusinessMetadata(connId, scopeKey, table, () => !disposed)
          .then(() => { if (!disposed) refreshChip(); })
          .catch(() => undefined);
      }, 400);
      return hideChip();
    }
    // 语句内点它实际是「在表名后追加 LEFT JOIN」，裸表名才是整条替换；文案统一叫联查。
    showChip(model, analysis.tokens[index].end, "主子表联查", `${hint} · Alt+Enter 或点击打开`,
      () => editor.trigger("sql-ghost", "editor.action.quickFix", {}));
  };

  const refreshLens = () => {
    clearTimeout(lensTimer);
    lens.clear();
    if (disposed || !getSqlTemplatesEnabled()) return;
    const model = editor.getModel(), caret = editor.getPosition();
    if (!model || !caret) return;
    if (meanings?.version !== model.getVersionId()) {
      meanings = { version: model.getVersionId(), list: sqlJoinMeanings(model.getValue(), dialectOfSqlModel(model)).slice(0, 20) };
    }
    const hit = meanings.list.find(m => model.getPositionAt(m.start).lineNumber === caret.lineNumber && model.getPositionAt(m.end).lineNumber === caret.lineNumber);
    if (!hit) return;
    const from = model.getPositionAt(hit.start), to = model.getPositionAt(hit.end);
    lens.set([{
      range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column),
      options: {
        after: { content: `  ${hit.move ? "排除无匹配主表行 · Alt+Enter" : "仅保留匹配行 · Alt+Enter"}`, inlineClassName: "ncforge-sql-lens" },
        hoverMessage: { value: hit.message },
      },
    }]);
  };

  const disposables: { dispose(): void }[] = [
    editor.onDidChangeCursorPosition(() => { refreshChip(); refreshLens(); }),
    editor.onDidChangeCursorSelection(refreshChip),
    editor.onDidChangeModelContent(() => {
      meanings = null;
      refreshChip();
      // 切语句时分析要重跑，延后一拍，避免每敲一个字母都扫全文。
      lensTimer = setTimeout(refreshLens, 250);
    }),
    editor.onDidChangeModel(() => { meanings = null; hideChip(); lens.clear(); refreshChip(); refreshLens(); }),
  ];
  refreshChip(); refreshLens();
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(warmTimer); clearTimeout(lensTimer);
      disposables.forEach(d => d.dispose());
      editor.removeContentWidget(widget);
      lens.clear();
      chip.remove();
    },
  };
}
