import { monaco } from "./monacoSetup";
import { dialectOfSqlModel, publishActiveSqlStatement, SQL_LANGUAGE_IDS } from "./monacoSql";
import { sqlAssistScope, verifiedSqlSource } from "./sqlAssistLearning";
import { rtOf, sqlColumnEpoch, sqlTabOf, subscribeDb } from "./dbStore";
import { sqlAssistColumns } from "./sqlAssistColumns";
import { tabIdOfModel } from "./sqlModels";
import { resolveSqlInspection, SQL_INSPECTION_DOCUMENT_LIMIT, type SqlInspectionIssue, type SqlInspectionPlan, type SqlInspectionCatalog } from "./sqlInspection";
import type { SqlInspectionRequest } from "./sqlInspectionWorker";
import type { SqlCodeAction } from "./sqlBillAssist";
import { sqlPreviewEdits } from "./sqlPreviewCode";

type Editor = monaco.editor.IStandaloneCodeEditor;
type Model = monaco.editor.ITextModel;
type Context = ReturnType<typeof contextOf>;
const MARKER_OWNER = "ncforge-sql-inspection";
const IDLE_MS = 100;

function contextOf(model: Model) {
  const conn = sqlTabOf(tabIdOfModel(model))?.connId ?? "";
  const rt = rtOf(conn);
  return { conn, scope: sqlAssistScope(conn), epoch: sqlColumnEpoch(conn), status: rt.status, catalog: rt.tables, schema: rt.schema };
}

function sameContext(a: Context, b: Context) {
  return a.conn === b.conn && a.scope === b.scope && a.epoch === b.epoch && a.status === b.status && a.catalog === b.catalog && a.schema === b.schema;
}

const rangeOf = (model: Model, issue: SqlInspectionIssue) =>
  monaco.Range.fromPositions(model.getPositionAt(issue.start), model.getPositionAt(issue.end));

async function readCatalog(plan: SqlInspectionPlan, context: Context, current: () => boolean): Promise<SqlInspectionCatalog> {
  const referenced = new Set(plan.references.flatMap(ref => ref.sources));
  const entries = await Promise.all(plan.sources.map(async source => {
    if (source.object.declaredColumnKeys) return [source.id, { columns: source.object.declaredColumnKeys }] as const;
    if (context.status !== "connected" || !context.scope) return;
    const verified = verifiedSqlSource(context.conn, source.object);
    // An explicit owner is enough to ask the dictionary for that exact object. Keep unqualified
    // unresolved names neutral: they could be private/public synonyms or outside our privileges.
    const explicit = source.object.schema && !source.object.quoted && /^(?:[a-z_][\w$#]*\.)[a-z_][\w$#]*$/i.test(source.object.tableRef ?? "")
      ? source.object.tableRef : undefined;
    const reference = verified && !verified.quoted ? verified.tableRef : explicit;
    const unknown = context.catalog && [source.id, { unconfirmed: true }] as const;
    if (!reference) return unknown;
    if (!referenced.has(source.id)) return;
    try {
      const columns = await sqlAssistColumns(context.conn, reference, current);
      if (columns.length) return [source.id, { columns: columns.map(column => column.name) }] as const;
    } catch {
      // Metadata failures carry no evidence that a column is missing.
    }
    return unknown;
  }));
  return Object.fromEntries(entries.filter(entry => entry !== undefined));
}

/** One analysis for the active statement, with every reply bound to the editor and schema snapshot. */
export function wireSqlInspection(editor: Editor, visible: () => boolean): monaco.IDisposable {
  if (typeof Worker === "undefined") return { dispose() {} };
  let worker: Worker | undefined, disposed = false, generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let marked: Model | null = null;
  let context: Context | undefined;
  let snapshot: { plan: SqlInspectionPlan; issues: SqlInspectionIssue[]; current: () => boolean; version: number } | undefined;

  function clear() {
    generation++;
    clearTimeout(timer);
    snapshot = undefined;
    if (marked && !marked.isDisposed()) {
      monaco.editor.setModelMarkers(marked, MARKER_OWNER, []);
      publishActiveSqlStatement(marked);
    }
    marked = null;
  }

  function schedule() {
    clear();
    if (disposed || !visible()) return;
    timer = setTimeout(() => {
      const model = editor.getModel(), position = editor.getPosition();
      if (!visible() || !model || !position || model.isDisposed() || model.getValueLength() > SQL_INSPECTION_DOCUMENT_LIMIT) return;
      const id = generation, version = model.getVersionId(), dialect = dialectOfSqlModel(model);
      const requestContext = context = contextOf(model);
      const current = () => !disposed && visible() && id === generation && editor.getModel() === model &&
        !model.isDisposed() && model.getVersionId() === version && dialectOfSqlModel(model) === dialect && sameContext(requestContext, contextOf(model));
      try {
        if (!worker) worker = new Worker(new URL("./sqlInspectionWorker.ts", import.meta.url), { type: "module" });
        worker.onerror = () => { worker?.terminate(); worker = undefined; };
        worker.onmessage = async ({ data }: MessageEvent<{ id: number; plan: SqlInspectionPlan | null }>) => {
          if (data.id !== id || !current() || !data.plan) return;
          const plan = data.plan;
          if (plan.activeAnalysis) publishActiveSqlStatement(model, plan.activeAnalysis);
          publish(plan.issues);
          if (plan.sources.length) {
            const catalog = await readCatalog(plan, requestContext, current);
            if (current()) publish(resolveSqlInspection(plan, catalog));
          }
          function publish(issues: SqlInspectionIssue[]) {
            if (!current()) return;
            snapshot = { plan, issues, current, version };
            marked = model;
            monaco.editor.setModelMarkers(model!, MARKER_OWNER, issues.map(issue => ({
              ...rangeOf(model!, issue),
              severity: issue.severity === "error" ? monaco.MarkerSeverity.Error : issue.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
              code: issue.code, source: "SQL 实时检查", message: issue.message,
            })));
          }
        };
        const request: SqlInspectionRequest = { id, text: model.getValue(), offset: model.getOffsetAt(position), dialect };
        worker.postMessage(request);
      } catch {
        worker?.terminate();
        worker = undefined;
      }
    }, IDLE_MS);
  }

  const disposables = [
    editor.onDidChangeModelContent(schedule), editor.onDidChangeModel(schedule), editor.onDidChangeModelLanguage(schedule),
    editor.onDidFocusEditorText(() => { if (!snapshot?.current()) schedule(); }),
    editor.onDidChangeCursorPosition(({ position }) => {
      const model = editor.getModel(), offset = model?.getOffsetAt(position);
      if (offset !== undefined && snapshot?.current() && offset >= snapshot.plan.range.start && offset <= snapshot.plan.range.end) return;
      schedule();
    }),
    { dispose: subscribeDb(() => {
      const model = editor.getModel();
      if (!model) return;
      const next = contextOf(model);
      if (!context || !sameContext(context, next)) { context = next; schedule(); }
    }) },
    ...SQL_LANGUAGE_IDS.map(language => monaco.languages.registerCodeActionProvider(language, {
      provideCodeActions(model, selection, _context, cancel) {
        if (cancel.isCancellationRequested || model !== editor.getModel() || !snapshot?.current()) return { actions: [], dispose() {} };
        const { issues, plan, current, version } = snapshot;
        const start = model.getOffsetAt(selection.getStartPosition()), end = model.getOffsetAt(selection.getEndPosition());
        const actions: SqlCodeAction[] = [];
        for (const issue of issues) {
          if (issue.start > end || issue.end < start || !issue.fixes?.length) continue;
          for (const fix of issue.fixes) {
            const edits = [{ start: issue.start, end: issue.end, text: fix.text }];
            actions.push({
              title: fix.label, kind: "quickfix",
              ncforgePreview: { ...sqlPreviewEdits(model.getValue(), plan.range.start, plan.range.end, edits), current, title: "修复 SQL", icon: "symbol-field", note: issue.message, dialect: dialectOfSqlModel(model) },
              edit: { edits: [{ resource: model.uri, versionId: version, textEdit: { range: rangeOf(model, issue), text: fix.text } }] },
            });
          }
        }
        return { actions, dispose() {} };
      },
    }, { providedCodeActionKinds: ["quickfix"] })),
  ];
  schedule();
  return { dispose() {
    disposed = true;
    clear();
    worker?.terminate();
    disposables.forEach(d => d.dispose());
  } };
}
