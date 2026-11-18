import { monaco } from "./monacoSetup";
import { rtOf, sqlColumnEpoch, sqlTabOf } from "./dbStore";
import { tabIdOfModel } from "./sqlModels";
import { dialectOfSqlModel, SQL_LANGUAGE_IDS } from "./monacoSql";
import { sqlSelectionActions, type SqlSelectionAction } from "./sqlSelectionActions";
import { prepareSqlBatchEdit } from "./sqlBatchAssist";
import { sqlAssistScope } from "./sqlAssistLearning";
import type { SqlCodeAction } from "./sqlBillAssist";

type Editor = monaco.editor.IStandaloneCodeEditor;
// Monaco and the inline hint often ask about the same selection during one keystroke.
const selectionCache = new WeakMap<monaco.editor.ITextModel, { key: string; actions: SqlSelectionAction[] }>();

export function sqlEditorSelectionActions(editor: Editor) {
  const model = editor.getModel(), selection = editor.getSelection();
  if (!model || model.isDisposed() || !selection || selection.isEmpty()) return;
  const connId = sqlTabOf(tabIdOfModel(model))?.connId;
  if (!connId || rtOf(connId).status !== "connected") return;
  const version = model.getVersionId(), dialect = dialectOfSqlModel(model);
  const start = model.getOffsetAt(selection.getStartPosition()), end = model.getOffsetAt(selection.getEndPosition());
  const key = `${version}|${start}|${end}|${dialect}`;
  let cached = selectionCache.get(model);
  if (cached?.key !== key) {
    cached = { key, actions: sqlSelectionActions(model.getValue(), start, end, dialect) };
    selectionCache.set(model, cached);
  }
  return { connId, model, version, dialect, start, end, actions: cached.actions };
}

export function wireSqlSelectionAssist(editor: Editor): monaco.IDisposable {
  let disposed = false;
  const disposables = SQL_LANGUAGE_IDS.map(language => monaco.languages.registerCodeActionProvider(language, {
    provideCodeActions(model, _range, _context, token) {
      const none: monaco.languages.CodeActionList = { actions: [], dispose() {} };
      if (disposed || model !== editor.getModel() || token.isCancellationRequested) return none;
      const selection = sqlEditorSelectionActions(editor);
      if (!selection?.actions.length) return none;
      const { start, end, version, connId, dialect } = selection;
      const sql = model.getValue(), scope = sqlAssistScope(connId), epoch = sqlColumnEpoch(connId);
      return {
        actions: selection.actions.map((action): SqlCodeAction => ({
          title: action.title,
          kind: "refactor.rewrite",
          command: { id: "ncforge.sql.runAction", title: action.title, arguments: [action.actionId] },
          ncforgePreview: action.id === "batch.in" ? {
            async read(isOpen) {
              const current = () => {
                if (disposed || !isOpen() || sqlAssistScope(connId) !== scope || sqlColumnEpoch(connId) !== epoch) return false;
                const latest = sqlEditorSelectionActions(editor);
                return latest?.model === model && latest.version === version && latest.connId === connId
                  && latest.dialect === dialect && latest.start === start && latest.end === end;
              };
              if (!current()) return "选区已变化，请重新打开操作菜单";
              return (await prepareSqlBatchEdit(connId, sql, { start, end }, dialect, current))?.text ?? "选区已变化，请重新打开操作菜单";
            },
          } : { description: true, text: `${action.detail}\n所选字段 ${sql.slice(start, end)}\n选择关联主表后可查看生成的 SQL` },
        })),
        dispose() {},
      };
    },
  }, { providedCodeActionKinds: ["refactor.rewrite"] }));
  return { dispose() { if (disposed) return; disposed = true; disposables.forEach(d => d.dispose()); } };
}
