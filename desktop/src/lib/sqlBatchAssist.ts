import type { monaco } from "./monacoSetup";
import type { SqlLanguage } from "sql-formatter";
import { connOf, rtOf, sqlColumnEpoch, sqlTabOf } from "./dbStore";
import { tabIdOfModel } from "./sqlModels";
import { dialectOfSqlModel } from "./monacoSql";
import { sqlAssistColumns } from "./sqlAssistColumns";
import { sqlAssistScope, verifiedSqlSource } from "./sqlAssistLearning";
import { sqlReferenceKey } from "./sqlLex";
import { getSqlFormatPrefs } from "./sqlFormatPrefs";
import { sqlBatchCondition, sqlBatchTarget, sqlBatchValues } from "./sqlBatchConditions";
import { toast } from "../components/ui/toast";

type Editor = monaco.editor.IStandaloneCodeEditor;
class SqlBatchFieldReadError extends Error {}
function selectionOffsets(editor: Editor, model: monaco.editor.ITextModel) {
  const selection = editor.getSelection();
  if (!selection) return null;
  return { start: model.getOffsetAt({ lineNumber: selection.startLineNumber, column: selection.startColumn }),
    end: model.getOffsetAt({ lineNumber: selection.endLineNumber, column: selection.endColumn }) };
}
function rangeOf(model: monaco.editor.ITextModel, start: number, end: number): monaco.IRange {
  const a = model.getPositionAt(start), b = model.getPositionAt(end);
  return { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column };
}

export async function prepareSqlBatchEdit(connId: string, sql: string, selection: { start: number; end: number }, dialect: SqlLanguage, current: () => boolean) {
  const target = sqlBatchTarget(sql, selection.start, selection.end, dialect);
  const verified = verifiedSqlSource(connId, target.source);
  if (!verified || verified.quoted) throw new Error("请使用当前 schema 中已确认且不带引号的表");
  const columns = await sqlAssistColumns(connId, verified.tableRef, current, true).catch(() => {
    throw new SqlBatchFieldReadError("暂时无法读取字段，请刷新表结构后重试");
  });
  if (!current() || !verifiedSqlSource(connId, target.source)) return;
  const key = sqlReferenceKey(target.column, target.columnRef, dialect);
  const matches = columns.filter(c => dialect === "plsql" || dialect === "postgresql" ? c.name === key : c.name.toLowerCase() === key.toLowerCase());
  if (matches.length !== 1) throw new Error("无法确认字段，请刷新表结构并检查字段名");
  const values = sqlBatchValues(sql.slice(selection.start, selection.end), matches[0].type ?? "");
  return { start: target.start, end: target.end, text: sqlBatchCondition(target.fieldRef, values, dialect, getSqlFormatPrefs().keywordCase) };
}

export function wireSqlBatchAssist(editor: Editor): monaco.IDisposable {
  let disposed = false, generation = 0;
  // A moved-away-and-back selection still invalidates the pending conversion.
  const selectionListener = editor.onDidChangeCursorSelection(() => generation++);
  const action = editor.addAction({ id: "ncforge.sql.batchIn", label: "转为 IN 条件", contextMenuGroupId: "navigation", contextMenuOrder: 4,
    run: async () => {
      const model = editor.getModel(), position = editor.getPosition();
      const tab = model && sqlTabOf(tabIdOfModel(model)), connId = tab?.connId;
      if (!model || !position || !connId || !connOf(connId) || rtOf(connId).status !== "connected") { toast("请先连接数据库，再转换 IN 条件", "info"); return; }
      const selection = selectionOffsets(editor, model);
      if (!selection || selection.start === selection.end) { toast("请先选中从 Excel 粘贴的一列值", "info"); return; }
      const sql = model.getValue(), dialect = dialectOfSqlModel(model);
      const version = model.getVersionId(), scope = sqlAssistScope(connId), epoch = sqlColumnEpoch(connId);
      const request = ++generation, offset = model.getOffsetAt(position);
      const stillCurrent = () => {
        if (disposed || model.isDisposed() || editor.getModel() !== model) return false;
        const currentSelection = selectionOffsets(editor, model), currentPosition = editor.getPosition();
        return model.getVersionId() === version && generation === request
          && sqlColumnEpoch(connId) === epoch && sqlAssistScope(connId) === scope && rtOf(connId).status === "connected"
          && sqlTabOf(tabIdOfModel(model))?.connId === connId && dialectOfSqlModel(model) === dialect
          && !!currentPosition && model.getOffsetAt(currentPosition) === offset && currentSelection?.start === selection.start && currentSelection.end === selection.end;
      };
      try {
        const edit = await prepareSqlBatchEdit(connId, sql, selection, dialect, stillCurrent);
        if (!edit || !stillCurrent()) return;
        editor.pushUndoStop();
        editor.executeEdits("sql-batch-in", [{ range: rangeOf(model, edit.start, edit.end), text: edit.text }]);
        editor.pushUndoStop(); editor.focus();
      } catch (error) {
        if (stillCurrent()) toast((error as Error).message, error instanceof SqlBatchFieldReadError ? "warning" : "info");
      }
    } });
  return { dispose() { if (disposed) return; disposed = true; generation++; selectionListener.dispose(); action.dispose(); } };
}
