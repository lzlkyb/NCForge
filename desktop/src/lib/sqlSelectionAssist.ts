/**
 * 选区类动作的 `Ctrl+.` 入口：把右键菜单里的三个动作搬到灯泡下。
 *
 * 「转为 IN 条件」「检查重复」「汇总」原先只在右键菜单（`contextMenuGroupId:
 * "navigation"`）里，而用户根本不会在一个 SQL 编辑器里点右键找功能。
 *
 * 🔴 为什么返回**命令型** CodeAction（`{ title, command }`）而不是 `edit`：
 * 这三个动作要等异步读库（校验字段类型、读关联主表）之后才 `executeEdits`，
 * 而 `CodeAction.edit` 必须同步返回。命令型 action 只是把菜单和实现接起来，
 * 一行 async 逻辑都不用改，也不会出现第二套判定。
 *
 * 判定在 `sqlSelectionActions`（纯函数、有单测），这里只管把结果翻译成 Monaco 的形状。
 */
import { monaco } from "./monacoSetup";
import { sqlTabOf } from "./dbStore";
import { tabIdOfModel } from "./sqlModels";
import { dialectOfSqlModel, SQL_LANGUAGE_IDS } from "./monacoSql";
import { sqlSelectionActions, type SqlSelectionAction } from "./sqlSelectionActions";

const CACHE_LIMIT = 32;

export function wireSqlSelectionAssist(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
  let disposed = false;
  // 判定要解析全文，而 Monaco 在选区存在时会反复问；按「模型版本 + 选区」缓存。
  const cache = new Map<string, SqlSelectionAction[]>();
  const disposables: monaco.IDisposable[] = [];
  for (const language of SQL_LANGUAGE_IDS) disposables.push(monaco.languages.registerCodeActionProvider(language, {
    provideCodeActions(model, _range, _context, token) {
      const none: monaco.languages.CodeActionList = { actions: [], dispose() {} };
      if (disposed || model !== editor.getModel() || model.isDisposed() || token.isCancellationRequested) return none;
      // 没有选区就什么都不给：三个动作都要求「先选中一列值或一列字段」，
      // 在光标处空给一条点了只弹 toast 的菜单，比不给更糟。
      const selection = editor.getSelection();
      if (!selection || selection.isEmpty()) return none;
      if (!sqlTabOf(tabIdOfModel(model))?.connId) return none;
      const start = model.getOffsetAt(selection.getStartPosition()), end = model.getOffsetAt(selection.getEndPosition());
      const key = `${model.getVersionId()}|${start}|${end}`;
      let actions = cache.get(key);
      if (!actions) {
        actions = sqlSelectionActions(model.getValue(), start, end, dialectOfSqlModel(model));
        cache.set(key, actions);
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      }
      if (!actions.length) return none;
      return {
        actions: actions.map((action): monaco.languages.CodeAction => ({
          title: action.title,
          kind: "refactor.rewrite",
          // `ncforge.sql.runAction` 按焦点编辑器转调同名 editor action，
          // 与补全列表里的动作项走同一个出口。
          command: { id: "ncforge.sql.runAction", title: action.title, arguments: [action.actionId] },
        })),
        dispose() {},
      };
    },
  }, { providedCodeActionKinds: ["refactor.rewrite"] }));
  return { dispose() { if (disposed) return; disposed = true; cache.clear(); disposables.forEach(d => d.dispose()); } };
}
