import { monaco } from "./monacoSetup";
import { connOf, rtOf, sqlTabOf } from "./dbStore";
import { connectionKey } from "./dbResultContext";
import { tabIdOfModel } from "./sqlModels";
import { dialectOfSqlModel, sqlAnalysisOf } from "./monacoSql";
import { sqlUsageScope } from "./sqlUsage";
import { billLinkHint } from "./sqlBillHint";
import { peekSqlBusinessMetadata, readSqlBusinessMetadata } from "./sqlBusiness";
import { getSqlTemplatesEnabled, subscribeSqlTemplates } from "./sqlTemplates";
import { sqlWildcardAt } from "./sqlScope";
import { verifiedSqlSource } from "./sqlAssistLearning";
import { sqlEditorSelectionActions } from "./sqlSelectionAssist";
import { sqlJoinContinuationAt } from "./sqlBillAssist";

type Editor = monaco.editor.IStandaloneCodeEditor;

export function wireSqlAssistGhost(editor: Editor): monaco.IDisposable {
  let disposed = false, warmTimer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0, position: monaco.editor.IOverlayWidgetPosition | null = null;
  const warmed = new Set<string>();

  const doc = editor.getDomNode()?.ownerDocument ?? document;
  const win = doc.defaultView!;
  const chip = doc.createElement("button"), glyph = doc.createElement("span"), label = doc.createElement("span");
  chip.type = "button";
  chip.className = "ncforge-sql-chip";
  glyph.setAttribute("aria-hidden", "true");
  label.className = "ncforge-sql-chip-label";
  chip.append(glyph, label);
  chip.hidden = true;
  // Keep editor focus and the original selection when opening a preview with the mouse.
  chip.addEventListener("mousedown", event => event.preventDefault());
  let chipRun: (() => void) | null = null;
  chip.addEventListener("click", () => chipRun?.());
  const widget: monaco.editor.IOverlayWidget = {
    getId: () => "ncforge.sql.assistChip",
    getDomNode: () => chip,
    getPosition: () => position,
  };
  editor.addOverlayWidget(widget);

  const placeChip = () => {
    if (disposed || !chipRun) return;
    const model = editor.getModel(), caret = editor.getPosition(), layout = editor.getLayoutInfo();
    const row = caret && editor.getScrolledVisiblePosition(caret);
    const visible = caret && row && row.top >= 0 && row.top + row.height <= layout.height
      && editor.getVisibleRanges().some(range => range.startLineNumber <= caret.lineNumber && caret.lineNumber <= range.endLineNumber);
    chip.hidden = !visible;
    position = null;
    if (model && caret && row && visible) {
      const line = caret.lineNumber;
      const start = editor.getScrolledVisiblePosition({ lineNumber: line, column: 1 });
      const end = editor.getScrolledVisiblePosition({ lineNumber: line, column: model.getLineMaxColumn(line) });
      const gap = parseFloat(win.getComputedStyle(chip).columnGap) || 0;
      const chipWidth = label.offsetWidth + gap * 2 + 2;
      const right = layout.contentLeft + layout.contentWidth - layout.verticalScrollbarWidth;
      // Monaco's visual rows can wrap or scroll independently of the SQL token offsets.
      const fits = !editor.getScrollLeft() && start && end && start.top === end.top
        && end.left >= layout.contentLeft && end.left + gap + chipWidth <= right;
      chip.dataset.placement = fits ? "end" : "gutter";
      const left = fits ? end.left + gap : layout.decorationsLeft + gap;
      position = { preference: { left, top: row.top + Math.max(0, (row.height - chip.offsetHeight) / 2) } };
    }
    editor.layoutOverlayWidget(widget);
  };

  const schedulePlacement = () => {
    if (!chipRun || frame) return;
    frame = win.requestAnimationFrame(() => { frame = 0; placeChip(); });
  };

  const showChip = (model: monaco.editor.ITextModel, target: number, text: string, title: string, icon: string, run: () => void, keepSelection = false) => {
    label.textContent = text;
    glyph.className = "codicon codicon-" + icon;
    chip.title = title;
    chip.setAttribute("aria-label", text + " · " + title);
    const version = model.getVersionId();
    chipRun = () => {
      if (disposed || editor.getModel() !== model || model.getVersionId() !== version) return;
      if (!keepSelection) editor.setPosition(model.getPositionAt(target));
      editor.focus(); run();
    };
    placeChip();
  };

  const hideChip = () => {
    if (!chipRun) return;
    position = null; chipRun = null; chip.hidden = true;
    editor.layoutOverlayWidget(widget);
  };

  const quickFix = () => editor.trigger("sql-ghost", "editor.action.quickFix", {});
  const showMeaning = (model: monaco.editor.ITextModel, caret: monaco.IPosition, offset: number) => {
    // Reuse the debounced diagnostics instead of scanning SQL again as the user types.
    const meanings = monaco.editor.getModelMarkers({ resource: model.uri }).filter(marker => marker.code === "left-join-where");
    const start = (m: monaco.editor.IMarker) => model.getOffsetAt({ lineNumber: m.startLineNumber, column: m.startColumn });
    const hit = meanings.find(m => start(m) <= offset && offset <= model.getOffsetAt({ lineNumber: m.endLineNumber, column: m.endColumn }))
      ?? meanings.find(m => m.startLineNumber === caret.lineNumber && m.endLineNumber === caret.lineNumber);
    if (!hit) return hideChip();
    showChip(model, start(hit), "关联修正", hit.message + " · Alt+Enter", "filter", quickFix);
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
      return showChip(model, selected.end, "选区操作", selected.actions.map(action => action.title).join("\n") + " · Alt+Enter", "list-selection", quickFix, true);
    }
    if (sqlJoinContinuationAt(editor)) return showChip(model, model.getOffsetAt(caret), "继续添加关联", "Alt+Enter", "references", quickFix, true);
    const dialect = dialectOfSqlModel(model);
    const analysis = sqlAnalysisOf(model), offset = model.getOffsetAt(caret);
    if (dialect === "plsql") {
      const wildcard = sqlWildcardAt(analysis, offset);
      const verified = wildcard?.source && verifiedSqlSource(connId, wildcard.source);
      if (wildcard && verified && !verified.quoted) {
        return showChip(model, analysis.tokens[wildcard.token].end, "展开字段",
          "把 * 展开成字段列表（带中文名）· Ctrl+空格", "symbol-field", () => editor.trigger("sql-ghost", "editor.action.triggerSuggest", {}));
      }
    }
    if (!getSqlTemplatesEnabled()) return hideChip();
    if (dialect !== "plsql") return showMeaning(model, caret, offset);
    const schema = rt.currentSchema ?? rt.info?.schema ?? "";
    const index = analysis.tokens.findIndex(t => t.start <= offset && t.end >= offset && ["identifier", "quoted"].includes(t.kind));
    const source = index < 0 ? undefined : analysis.scopes.flatMap(s => s.sources).find(s => s.declaration === index);
    const table = source?.table;
    if (!table || source.schema && source.schema.toLowerCase() !== schema.toLowerCase()) return showMeaning(model, caret, offset);
    const scopeKey = sqlUsageScope(connectionKey(connOf(connId)), schema), available = (rt.tables ?? []).map(t => t.name);
    const hint = billLinkHint(connId, scopeKey, table, available);
    if (!hint) {
      // Only offer the table action once there is a known relationship to preview.
      const key = connId + "|" + scopeKey + "|" + table;
      if (!peekSqlBusinessMetadata(connId, scopeKey, table) && !warmed.has(key)) warmTimer = setTimeout(() => {
        warmed.add(key);
        void readSqlBusinessMetadata(connId, scopeKey, table, () => !disposed)
          .then(() => { if (!disposed) refreshChip(); })
          .catch(() => undefined);
      }, 400);
      return showMeaning(model, caret, offset);
    }
    showChip(model, analysis.tokens[index].end, "主子表联查", hint + " · Alt+Enter", "references", quickFix);
  };

  const disposables = [
    editor.onDidChangeCursorSelection(refreshChip),
    editor.onDidChangeModelContent(() => queueMicrotask(refreshChip)),
    editor.onDidChangeModel(() => { hideChip(); refreshChip(); }),
    editor.onDidScrollChange(schedulePlacement),
    editor.onDidLayoutChange(schedulePlacement),
    editor.onDidChangeConfiguration(schedulePlacement),
    editor.onDidChangeHiddenAreas(schedulePlacement),
    monaco.editor.onDidChangeMarkers(resources => {
      const resource = editor.getModel()?.uri.toString();
      if (resources.some(uri => uri.toString() === resource)) refreshChip();
    }),
    { dispose: subscribeSqlTemplates(refreshChip) },
  ];
  refreshChip();
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(warmTimer);
      win.cancelAnimationFrame(frame);
      disposables.forEach(d => d.dispose());
      editor.removeOverlayWidget(widget);
    },
  };
}
