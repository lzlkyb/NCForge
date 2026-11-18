import { monaco } from "./monacoSetup";
import { dialectOfSqlModel, SQL_LANGUAGE_IDS } from "./monacoSql";
import { getSqlTemplatesEnabled, subscribeSqlTemplates } from "./sqlTemplates";
import { sqlJoinMeanings, type MeaningEdit } from "./sqlJoinMeaning";
import type { SqlCodeAction } from "./sqlBillAssist";
import { splitStatements } from "./sqlSplit";

let ownerId = 0;
export function wireSqlJoinMeaningAssist(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
  const owner = `ncforge-sql-meaning-${++ownerId}`;
  let disposed = false, model = editor.getModel(), timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { clearTimeout(timer); timer = undefined; if (model && !model.isDisposed()) monaco.editor.setModelMarkers(model, owner, []); };
  const update = () => {
    if (disposed || !model || model.isDisposed() || !getSqlTemplatesEnabled()) return;
    const current = model;
    const meanings = sqlJoinMeanings(current.getValue(), dialectOfSqlModel(current));
    monaco.editor.setModelMarkers(current, owner, meanings.map(m => {
      const a = current.getPositionAt(m.start), b = current.getPositionAt(m.end);
      return { severity: monaco.MarkerSeverity.Info, code: "left-join-where", source: "查询条件含义", message: m.message,
        startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column };
    }));
  };
  const schedule = () => { clear(); if (!disposed && getSqlTemplatesEnabled()) timer = setTimeout(() => { timer = undefined; update(); }, 250); };
  const disposables = [editor.onDidChangeModelContent(schedule), editor.onDidChangeModel(() => { clear(); model = editor.getModel(); schedule(); }),
    { dispose: subscribeSqlTemplates(() => { clear(); update(); }) }];
  for (const language of SQL_LANGUAGE_IDS) disposables.push(monaco.languages.registerCodeActionProvider(language, {
    provideCodeActions(current, range, _context, token) {
      if (disposed || current !== editor.getModel() || current.isDisposed() || token.isCancellationRequested || !getSqlTemplatesEnabled()) return { actions: [], dispose() {} };
      const version = current.getVersionId(), start = current.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }), end = current.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
      const sql = current.getValue(), actions: SqlCodeAction[] = [];
      const action = (title: string, edits: MeaningEdit[]): SqlCodeAction => {
        const first = Math.min(...edits.map(e => e.start)), last = Math.max(...edits.map(e => e.end));
        const statement = splitStatements(sql).find(s => s.start <= first && s.end >= last);
        const base = statement?.start ?? first;
        let preview = sql.slice(base, statement?.end ?? last);
        for (const edit of [...edits].sort((a, b) => b.start - a.start)) preview = preview.slice(0, edit.start - base) + edit.text + preview.slice(edit.end - base);
        return { title, kind: "quickfix", ncforgePreview: { text: preview.trim() }, edit: { edits: edits.map(e => ({ resource: current.uri, versionId: version,
          textEdit: { range: monaco.Range.fromPositions(current.getPositionAt(e.start), current.getPositionAt(e.end)), text: e.text } })) } };
      };
      for (const meaning of sqlJoinMeanings(sql, dialectOfSqlModel(current))) {
        if (meaning.start > end || meaning.end < start) continue;
        if (meaning.move) actions.push(action("将此条件移入 ON（调整筛选范围）", meaning.move));
        if (meaning.inner) actions.push(action("仅保留匹配记录：明确使用 INNER JOIN", [meaning.inner]));
      }
      return { actions, dispose() {} };
    },
  }, { providedCodeActionKinds: ["quickfix"] }));
  update();
  return { dispose() { if (disposed) return; disposed = true; clear(); disposables.forEach(d => d.dispose()); } };
}
