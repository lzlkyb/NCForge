import { monaco } from "./monacoSetup";
import { connOf, rtOf, sqlColumnEpoch, sqlTabOf } from "./dbStore";
import { tabIdOfModel } from "./sqlModels";
import { dialectOfSqlModel } from "./monacoSql";
import { sqlAssistColumns } from "./sqlAssistColumns";
import { sqlAssistScope, verifiedSqlSource } from "./sqlAssistLearning";
import { readSqlBusinessMetadata } from "./sqlBusiness";
import { billQueryRelations } from "./sqlBillTemplates";
import { buildDetailSummaryChecks, buildDuplicateCombinationCheck, selectedQueryFields } from "./sqlQueryChecks";
import { getSqlFormatPrefs } from "./sqlFormatPrefs";
import { splitStatements } from "./sqlSplit";
import { scanSql } from "./sqlLex";
import { toast } from "../components/ui/toast";
import { openSqlAssistPicker } from "./sqlAssistPicker";

type Editor = monaco.editor.IStandaloneCodeEditor;
function rangeOf(model: monaco.editor.ITextModel, start: number, end: number) { return monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(end)); }

export function wireSqlQueryCheckAssist(editor: Editor): monaco.IDisposable {
  let disposed = false, generation = 0;
  const clear = () => { generation++; };
  const disposables = [editor.onDidChangeCursorSelection(clear), editor.onDidChangeModelContent(clear), editor.onDidChangeModel(clear)];
  async function generate(summary: boolean) {
    const model = editor.getModel(), position = editor.getPosition(), selected = editor.getSelection();
    const connId = model && sqlTabOf(tabIdOfModel(model))?.connId;
    if (!model || !position || !selected || !connId || !connOf(connId) || rtOf(connId).status !== "connected") { toast("请先连接数据库，再选择查询字段", "info"); return; }
    if (dialectOfSqlModel(model) !== "plsql") { toast("此查询生成目前支持 Oracle，请保留手写 SQL", "info"); return; }
    const start = model.getOffsetAt(selected.getStartPosition()), end = model.getOffsetAt(selected.getEndPosition()), sql = model.getValue();
    let selection;
    try { selection = selectedQueryFields(sql, start, end); } catch (error) { toast((error as Error).message, "info"); return; }
    const source = verifiedSqlSource(connId, selection.source);
    if (!source || source.quoted) { toast("请选择当前 schema 中已确认表的字段", "info"); return; }
    const version = model.getVersionId(), scope = sqlAssistScope(connId), epoch = sqlColumnEpoch(connId), offset = model.getOffsetAt(position), request = ++generation;
    const metadataCurrent = () => !disposed && dialectOfSqlModel(model) === "plsql" && sqlAssistScope(connId) === scope && sqlColumnEpoch(connId) === epoch && rtOf(connId).status === "connected" && sqlTabOf(tabIdOfModel(model))?.connId === connId;
    const contextCurrent = () => metadataCurrent() && !model.isDisposed() && editor.getModel() === model && model.getVersionId() === version && request === generation
      && !!editor.getPosition() && model.getOffsetAt(editor.getPosition()!) === offset;
    const title = summary ? "明细汇总" : "重复检查";
    const icon = summary ? "graph" : "checklist";
    await openSqlAssistPicker(editor, title, icon, contextCurrent, async current => {
      const [columns, metadata] = await Promise.all([sqlAssistColumns(connId, source.tableRef, current, true), summary ? readSqlBusinessMetadata(connId, scope!, selection.table, current) : Promise.resolve(null)]);
      if (!current()) return [];
      // The selection is on details: spend the bounded column reads on outgoing parent relations.
      const parents = metadata && { ...metadata, relations: metadata.relations.filter(r => r.source.toLowerCase() === selection.table.toLowerCase()) };
      const rt = rtOf(connId), tables = (rt.tables ?? []).map(t => t.name), related = summary ? billQueryRelations(selection.table, tables, parents).slice(0, 8) : [];
      const other = await Promise.all([...new Set(related.map(r => r.table))].map(async table => [table, await sqlAssistColumns(connId, table, current)] as const));
      if (!current()) return [];
      const context = { tables, columns: { [selection.table.toLowerCase()]: columns, ...Object.fromEntries(other) }, names: rt.ncNames, schema: rt.currentSchema ?? rt.info?.schema, upper: getSqlFormatPrefs().keywordCase !== "lower" };
      const templates = summary ? buildDetailSummaryChecks(sql, start, end, metadata, context) : [buildDuplicateCombinationCheck(sql, start, end, context)];
      if (!templates.length) throw new Error("没有可确认完整主键的关联主表，请加载关系与字段后重试");
      if (!current()) return [];
      const statement = splitStatements(sql).find(s => s.start <= start && s.end >= end);
      if (!statement) return [];
      const at = statement.end, body = sql.slice(statement.start, at);
      // A fresh line escapes trailing -- comments; retain an existing standalone slash terminator.
      const terminated = sql[at - 1] === ";" && scanSql(body, "plsql").tokens.slice(-1)[0]?.text === ";" || /(?:^|\n)[\t \r]*\/[\t \r]*$/.test(body);
      const prefix = terminated ? "\n\n" : "\n;\n\n";
      return templates.map(template => {
        const text = `${prefix}-- ${template.label.replace(/[\r\n]/g, " ")}\n${template.sql}`;
        const rootLabel = rt.ncNames?.[template.root.toLowerCase()];
        const severalFromRoot = templates.filter(candidate => candidate.root === template.root).length > 1;
        return {
          label: summary ? rootLabel || template.root : "按所选字段检查重复",
          detail: summary ? severalFromRoot ? template.hint.split(" · ")[1]?.split("；")[0] : rootLabel ? template.root : undefined : undefined,
          preview: { title, icon, text: text.trim(), note: "全表范围 · 不带入原 WHERE 条件" },
          apply: () => {
            editor.pushUndoStop();
            editor.executeEdits("sql-query-check", [{ range: rangeOf(model, at, at), text }]);
            editor.pushUndoStop();
            // Monaco normalizes inserted newlines to the active model's EOL.
            editor.setPosition(model.getPositionAt(at + model.getValue().length - sql.length));
            editor.focus();
            toast("已追加全表查询，可在新 SQL 中添加筛选条件", "success");
          },
        };
      });
    });
  }
  for (const [id, label, summary] of [["ncforge.sql.checkDuplicates", "按所选字段检查重复（全表）", false], ["ncforge.sql.detailSummary", "按所选明细字段汇总（全表）", true]] as const) {
    disposables.push(editor.addAction({ id, label, contextMenuGroupId: "navigation", contextMenuOrder: 4, run: () => generate(summary) }));
  }
  return { dispose() { if (disposed) return; clear(); disposed = true; disposables.forEach(d => d.dispose()); } };
}
