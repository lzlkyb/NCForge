import { monaco } from "./monacoSetup";
import { connOf, rtOf, sqlColumnEpoch, sqlTabOf } from "./dbStore";
import { tabIdOfModel } from "./sqlModels";
import { dialectOfSqlModel } from "./monacoSql";
import { sqlAssistColumns } from "./sqlAssistColumns";
import { sqlAssistScope, verifiedSqlSource } from "./sqlAssistLearning";
import { readSqlBusinessMetadata } from "./sqlBusiness";
import { billQueryRelations } from "./sqlBillTemplates";
import { buildDetailSummaryChecks, buildDuplicateCombinationCheck, selectedQueryFields, type SqlQueryCheckTemplate } from "./sqlQueryChecks";
import { getSqlFormatPrefs } from "./sqlFormatPrefs";
import { splitStatements } from "./sqlSplit";
import { scanSql } from "./sqlLex";
import { toast } from "../components/ui/toast";

type Editor = monaco.editor.IStandaloneCodeEditor;
let pickerId = 0;
const choices = new WeakMap<monaco.editor.ITextModel, { offset: number; current: () => boolean; templates: SqlQueryCheckTemplate[]; command: string; generation: number }>();
function rangeOf(model: monaco.editor.ITextModel, start: number, end: number) { return monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(end)); }

/** Several verified parent relations use the same completion picker rather than guessing a parent. */
export function queryCheckChoices(model: monaco.editor.ITextModel, position: monaco.Position): monaco.languages.CompletionList | undefined {
  const pending = choices.get(model);
  if (!pending) return;
  if (!pending.current() || model.getOffsetAt(position) !== pending.offset) { choices.delete(model); return; }
  return { suggestions: pending.templates.map((template, i) => ({ label: { label: template.label, description: template.hint },
    kind: monaco.languages.CompletionItemKind.Snippet, insertText: "", range: rangeOf(model, pending.offset, pending.offset),
    command: { id: pending.command, title: "选择关联主表", arguments: [pending.generation, i] },
    sortText: String(i).padStart(2, "0"), preselect: i === 0, documentation: { value: `全表范围，原查询的条件不带入。\n\n\`\`\`sql\n${template.sql}\n\`\`\`` } })) };
}

export function wireSqlQueryCheckAssist(editor: Editor): monaco.IDisposable {
  let disposed = false, generation = 0;
  const chooseCommand = `ncforge.sql.chooseSummary.${++pickerId}`;
  const clear = () => { generation++; const model = editor.getModel(); if (model) choices.delete(model); };
  const disposables = [editor.onDidChangeCursorSelection(clear), editor.onDidChangeModelContent(clear), editor.onDidChangeModel(clear)];
  disposables.push(monaco.editor.registerCommand(chooseCommand, (_accessor, offeredGeneration: number, index: number) => {
    const model = editor.getModel(), position = editor.getPosition(), pending = model && choices.get(model);
    // Monaco may cache a visible item across reconnects: verify again before inserting any SQL.
    if (!model || !position || !pending || offeredGeneration !== pending.generation || !pending.current() || model.getOffsetAt(position) !== pending.offset) { if (model) choices.delete(model); return; }
    const template = Number.isInteger(index) && pending.templates[index];
    if (!template) return;
    choices.delete(model);
    const before = model.getValue().length;
    editor.pushUndoStop(); editor.executeEdits("sql-query-check-choice", [{ range: rangeOf(model, pending.offset, pending.offset), text: template.sql }]); editor.pushUndoStop();
    editor.setPosition(model.getPositionAt(pending.offset + model.getValue().length - before)); editor.focus();
  }));
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
    const current = () => metadataCurrent() && !model.isDisposed() && editor.getModel() === model && model.getVersionId() === version && request === generation
      && !!editor.getPosition() && model.getOffsetAt(editor.getPosition()!) === offset;
    try {
      const [columns, metadata] = await Promise.all([sqlAssistColumns(connId, source.tableRef, current, true), summary ? readSqlBusinessMetadata(connId, scope!, selection.table, current) : Promise.resolve(null)]);
      if (!current()) return;
      // The selection is on details: spend the bounded column reads on outgoing parent relations.
      const parents = metadata && { ...metadata, relations: metadata.relations.filter(r => r.source.toLowerCase() === selection.table.toLowerCase()) };
      const rt = rtOf(connId), tables = (rt.tables ?? []).map(t => t.name), related = summary ? billQueryRelations(selection.table, tables, parents).slice(0, 8) : [];
      const other = await Promise.all([...new Set(related.map(r => r.table))].map(async table => [table, await sqlAssistColumns(connId, table, current)] as const));
      if (!current()) return;
      const context = { tables, columns: { [selection.table.toLowerCase()]: columns, ...Object.fromEntries(other) }, names: rt.ncNames, schema: rt.currentSchema ?? rt.info?.schema, upper: getSqlFormatPrefs().keywordCase !== "lower" };
      const templates = summary ? buildDetailSummaryChecks(sql, start, end, metadata, context) : [buildDuplicateCombinationCheck(sql, start, end, context)];
      if (!templates.length) { toast("没有可确认完整主键的关联主表，请加载关系与字段后重试", "info"); return; }
      if (!current()) return;
      const statement = splitStatements(sql).find(s => s.start <= start && s.end >= end);
      if (!statement) return;
      const at = statement.end, body = sql.slice(statement.start, at);
      // A fresh line escapes trailing -- comments; retain an existing standalone slash terminator.
      const terminated = sql[at - 1] === ";" && scanSql(body, "plsql").tokens.slice(-1)[0]?.text === ";" || /(?:^|\n)[\t \r]*\/[\t \r]*$/.test(body);
      const prefix = terminated ? "\n\n" : "\n;\n\n";
      const text = templates.length === 1 ? `${prefix}-- ${templates[0].label.replace(/[\r\n]/g, " ")}\n${templates[0].sql}` : `${prefix}-- 选择关联主表汇总（全表范围，原 WHERE 条件不带入）\n`;
      editor.pushUndoStop(); editor.executeEdits("sql-query-check", [{ range: rangeOf(model, at, at), text }]); editor.pushUndoStop();
      // Monaco normalizes newlines to the model EOL; LF template length is wrong for CRLF models.
      const inserted = at + model.getValue().length - sql.length;
      editor.setPosition(model.getPositionAt(inserted)); editor.focus();
      if (templates.length > 1) {
        const chosenVersion = model.getVersionId(), chosenGeneration = generation;
        choices.set(model, { offset: inserted, templates, command: chooseCommand, generation: chosenGeneration, current: () => metadataCurrent() && editor.getModel() === model && !model.isDisposed() && model.getVersionId() === chosenVersion && generation === chosenGeneration });
        editor.trigger("sql-query-check", "editor.action.triggerSuggest", {});
      }
      toast("已追加全表查询，原查询保留；可在新 SQL 中添加筛选条件", "success");
    } catch (error) { if (current()) toast((error as Error).message || "暂时无法读取字段，请刷新表结构后重试", "info"); }
  }
  for (const [id, label, summary] of [["ncforge.sql.checkDuplicates", "按所选字段检查重复（全表）", false], ["ncforge.sql.detailSummary", "按所选明细字段汇总（全表）", true]] as const) {
    disposables.push(editor.addAction({ id, label, contextMenuGroupId: "navigation", contextMenuOrder: 4, run: () => generate(summary) }));
  }
  return { dispose() { if (disposed) return; clear(); disposed = true; disposables.forEach(d => d.dispose()); } };
}
