import { monaco } from "./monacoSetup";
import type { SqlCompletionItem } from "./sqlExplicitCompletion";
import { createSqlAssistPreview, type SqlAssistPreview } from "./sqlAssistPreview";
import { dismissSqlAssistPicker, markSqlAssistPickerShown } from "./sqlAssistPicker";

type Editor = monaco.editor.IStandaloneCodeEditor;
type Size = { width: number; height: number };
type SuggestionModel = { items: readonly { textLabel: string; completion: SqlCompletionItem }[] };
type SuggestionEvent = { item: { completion: SqlCompletionItem } };
type Renderer = { renderElement(item: SuggestionEvent["item"], index: number, data: {
  root: HTMLElement;
  iconContainer: HTMLElement;
  left: HTMLElement;
  parametersLabel: HTMLElement;
  keyBadges?: { group: HTMLElement; primary: HTMLElement; foreign: HTMLElement };
}, height?: number): void };

// Monaco 0.52 exposes completion content, but has no public option for popup width
// or wrapping rows. Keep its virtual list, focus, placement and resize handles.
interface SuggestWidget {
  element: { domNode: HTMLElement; size: Size };
  onDidShow(listener: () => void): monaco.IDisposable;
  onDidHide(listener: () => void): monaco.IDisposable;
  onDidFocus(listener: (event: { item: { completion: SqlCompletionItem } }) => void): monaco.IDisposable;
  getLayoutInfo(): { defaultSize: Size; itemHeight: number; statusBarHeight: number; borderHeight: number };
  _layout(size?: Size): void;
  _completionModel?: SuggestionModel;
  showSuggestions(model: SuggestionModel, index: number, frozen: boolean, auto: boolean, noFocus: boolean): void;
  getFocusedItem(): { item: { completion: SqlCompletionItem } } | undefined;
  _isDetailsVisible(): boolean;
  showDetails(loading: boolean): void;
  toggleDetails(): void;
  _details?: { hide(): void };
  _list: {
    contentHeight: number;
    layout(height: number, width: number): void;
    getFocus(): number[];
    setFocus(indexes: number[]): void;
    view: {
      supportDynamicHeights: boolean;
      renderers?: Map<string, { renderers: Renderer[] }>;
      virtualDelegate: { hasDynamicHeight?: () => boolean; getDynamicHeight?: () => number | null };
      rerender(): void;
    };
  };
}

export function wireSqlSuggestLayout(editor: Editor): monaco.IDisposable {
  const controller = editor.getContribution("editor.contrib.suggestController") as unknown as {
    widget?: { value: SuggestWidget };
    _insertSuggestion(event: SuggestionEvent | undefined, flags: number): void;
    cancelSuggestWidget(): void;
  } | null;
  const widget = controller?.widget?.value;
  const view = widget?._list?.view;
  const listNode = widget?.element?.domNode.querySelector<HTMLElement>(":scope > .tree");
  if (!controller || !widget || !view?.virtualDelegate || !view.rerender || !widget._layout || !listNode) return { dispose() {} };

  const node = widget.element.domNode;
  const editorNode = editor.getContainerDomNode();
  const doc = node.ownerDocument;
  const canvas = doc.createElement("canvas").getContext("2d");
  const previewView = createSqlAssistPreview(doc);
  const { top, panel, code, footer } = previewView;
  top.classList.add("dbx-sql-suggest-heading");
  panel.classList.add("dbx-sql-suggest-preview");
  footer.classList.add("dbx-sql-suggest-keys");
  node.prepend(top);
  node.append(panel, footer);
  let active: SqlAssistPreview | undefined;
  let showing = false;
  const isSplit = () => active !== undefined && !node.classList.contains("message");
  const setPreview = (completion?: SqlCompletionItem) => {
    const next = completion?.ncforgePreview;
    const changedLayout = (active === undefined) !== (next === undefined);
    node.toggleAttribute("data-sql-explicit", completion?.ncforgeExplicit === true);
    node.toggleAttribute("data-sql-suggest-preview", next !== undefined);
    node.toggleAttribute("data-sql-expanded-fields", next?.icon === "symbol-field");
    if (next !== active) {
      active = next;
      if (next) {
        widget._details?.hide();
        previewView.update(next, "SQL 辅助");
      }
      else previewView.clear();
    }
    if (changedLayout && !showing && node.classList.contains("visible")) widget._layout();
  };
  const info = widget.getLayoutInfo;
  const layout = widget._layout;
  const show = widget.showSuggestions;
  const insert = controller._insertSuggestion;
  controller._insertSuggestion = (event, flags) => {
    const completion = event?.item.completion;
    if (completion?.ncforgePreview?.current && !completion.ncforgePreview.current()) {
      previewView.update(completion.ncforgePreview);
      return;
    }
    if (completion?.ncforgePicker || completion?.ncforgeApply) {
      if (completion.ncforgeApply) {
        controller.cancelSuggestWidget();
        completion.ncforgeApply(editor);
      }
      return;
    }
    insert.call(controller, event, flags);
  };
  const renderer = view.renderers?.get("suggestion")?.renderers.slice(-1)[0];
  const renderRow = renderer?.renderElement;
  if (renderer && renderRow) renderer.renderElement = function (item, index, data, height) {
    renderRow.call(this, item, index, data, height);
    const { ncforgeColumnKeys: keys, ncforgePreview, label } = item.completion;
    const icon = ncforgePreview?.icon ?? (keys ? keys.primary ? "key" : "ncforge-column-foreign" : undefined);
    if (icon) data.iconContainer.className = `suggest-icon codicon codicon-${icon}`;
    data.root.toggleAttribute("data-sql-key-column", !!keys);
    if (!keys) {
      data.keyBadges?.group.remove();
      return;
    }
    if (keys.primary && keys.foreign) data.root.dataset.sqlKeyColumn = "both";
    else data.root.dataset.sqlKeyColumn = "single";
    if (!data.keyBadges) {
      const group = doc.createElement("span"), primary = doc.createElement("span"), foreign = doc.createElement("span");
      group.className = "dbx-sql-key-badges";
      primary.textContent = "主键";
      foreign.textContent = "外键";
      group.append(primary, foreign);
      data.keyBadges = { group, primary, foreign };
    }
    const badges = data.keyBadges;
    // Virtual rows are reused for ordinary fields; set both roles on every render.
    if (!badges.group.parentElement) data.left.insertBefore(badges.group, data.parametersLabel);
    badges.group.title = keys.detail;
    badges.primary.hidden = !keys.primary;
    badges.foreign.hidden = !keys.foreign;
    const text = typeof label === "string" ? label : [label.label, label.detail?.trim(), label.description].filter(Boolean).join("，");
    data.root.setAttribute("aria-label", `${text}，${[keys.primary && "主键", keys.foreign && "外键"].filter(Boolean).join("，")}`);
  };
  const showDetails = widget.showDetails, toggleDetails = widget.toggleDetails;
  widget.getLayoutInfo = () => {
    const native = info.call(widget);
    if (!isSplit()) return native;
    // Reserve the shared header and footer inside Monaco's placement budget.
    const height = Math.min(244, Math.floor(doc.documentElement.clientHeight * .38));
    const chrome = (top.offsetHeight + footer.offsetHeight) || native.itemHeight * 3;
    return { ...native, statusBarHeight: Math.max(chrome, height - Math.max(native.itemHeight, widget._list.contentHeight)) };
  };
  widget.showDetails = loading => { if (!isSplit()) showDetails.call(widget, loading); };
  widget.toggleDetails = () => { if (!isSplit()) toggleDetails.call(widget); };
  widget.showSuggestions = (model, index, frozen, auto, noFocus) => {
    showing = true;
    try {
      const selected = model.items[index]?.completion;
      const preview = selected?.ncforgePreview;
      if (selected?.ncforgePicker) markSqlAssistPickerShown(editor.getModel(), editor, !!preview && "status" in preview && preview.status === "loading");
      editorNode?.toggleAttribute("data-sql-suggest-open", model.items.length > 0);
      setPreview(selected);
      show.call(widget, model, index, frozen, auto, noFocus);
      // Monaco 0.52 waits 100 ms before marking the list visible. Plain completions
      // can show immediately; explicit previews follow the widget's usual focus/layout lifecycle.
      if (selected && !selected.ncforgePreview && !selected.ncforgeExplicit
        && !node.classList.contains("message") && !node.classList.contains("visible")) {
        node.classList.add("visible");
        if (needsMeasurement && !isSplit()) widget._layout(widget.element.size);
      }
    } finally { showing = false; }
  };
  const geometry = view.virtualDelegate;
  const previousDynamic = view.supportDynamicHeights;
  const previousDelegate = geometry.hasDynamicHeight;
  const previousHeight = geometry.getDynamicHeight;
  let needsMeasurement = false;
  const canMeasure = () => node.classList.contains("visible") && node.offsetWidth > 0 && listNode.style.display !== "none";
  view.supportDynamicHeights = true;
  geometry.hasDynamicHeight = () => true;
  geometry.getDynamicHeight = () => {
    // Monaco replaces the items before revealing the list. An offsetHeight read
    // at that point would cache zero and collapse all of its virtual rows.
    if (canMeasure()) return null;
    needsMeasurement = true;
    return widget.getLayoutInfo().itemHeight;
  };
  node.classList.add("dbx-suggest-fit");

  widget._layout = (size) => {
    const items = widget._completionModel?.items;
    if (!items?.length || node.classList.contains("message")) return layout.call(widget, size);
    const font = editor.getOption(monaco.editor.EditorOption.fontInfo);
    const fontSize = editor.getOption(monaco.editor.EditorOption.suggestFontSize) || font.fontSize;
    const lineHeight = editor.getOption(monaco.editor.EditorOption.suggestLineHeight) || font.lineHeight;
    node.style.setProperty("--sql-suggest-line-height", `${lineHeight}px`);
    const fallback = size ?? widget.getLayoutInfo().defaultSize;
    const available = Math.max(1, node.ownerDocument.body.clientWidth - 32);
    if (isSplit()) {
      const { statusBarHeight, itemHeight, borderHeight } = widget.getLayoutInfo();
      const content = Math.min(widget._list.contentHeight, doc.documentElement.clientHeight * .36);
      layout.call(widget, { width: Math.min(660, available), height: statusBarHeight + Math.max(itemHeight, content) + borderHeight });
      if (listNode.clientWidth > 0) widget._list.layout(listNode.clientHeight, listNode.clientWidth);
      return;
    }
    const cap = Math.min(640, available);
    let width = Math.min(fallback.width, available);
    if (canvas && width < cap) {
      canvas.font = `bold ${fontSize}px ${font.fontFamily}`;
      for (const item of items) {
        if (item.completion.kind !== monaco.languages.CompletionItemKind.Snippet) continue;
        // Reserve the icon, details chevron, scrollbar and row padding.
        const room = Math.ceil(canvas.measureText(item.textLabel).width + Math.max(0, font.letterSpacing) * item.textLabel.length) + lineHeight + 44;
        width = Math.max(width, Math.min(cap, room));
        if (width >= cap) break;
      }
    }

    const previousWidth = widget.element.size.width;
    layout.call(widget, { width, height: fallback.height });
    if (canMeasure() && (needsMeasurement || widget.element.size.width !== previousWidth)) {
      // The list is laid out before the widget width is applied. Recheck wrapping at
      // the new width so the virtual rows and keyboard scrolling use the same heights.
      const contentHeight = widget._list.contentHeight;
      needsMeasurement = false;
      view.rerender();
      if (widget._list.contentHeight !== contentHeight) layout.call(widget, { width, height: fallback.height });
    }
  };

  const resize = editor.onDidLayoutChange(() => {
    if (node.classList.contains("visible") && widget._completionModel?.items.length) widget._layout(widget.element.size);
  });
  const shown = widget.onDidShow(() => {
    if (isSplit() || needsMeasurement) widget._layout(widget.element.size);
  });
  const hidden = widget.onDidHide(() => {
    editorNode?.removeAttribute("data-sql-suggest-open");
    dismissSqlAssistPicker(editor.getModel());
    setPreview();
  });
  const focused = widget.onDidFocus(({ item }) => setPreview(item.completion));
  const hover = (event: PointerEvent) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(".monaco-list-row[data-index]");
    if (!row) return;
    const index = Number(row.dataset.index), item = widget._completionModel?.items[index];
    if (item && (active || item.completion.ncforgePreview) && widget._list.getFocus()[0] !== index) widget._list.setFocus([index]);
  };
  listNode.addEventListener("pointermove", hover);
  const preview = editor.onKeyDown(event => {
    const key = event.browserEvent;
    if (key.shiftKey || key.altKey || key.ctrlKey || key.metaKey || key.isComposing) return;
    if (isSplit() && (key.key === "PageUp" || key.key === "PageDown")) {
      code.scrollTop += (key.key === "PageUp" ? -1 : 1) * code.clientHeight;
      event.preventDefault(); event.stopPropagation();
      return;
    }
    if (!["ArrowRight", "ArrowLeft"].includes(key.key)) return;
    const selected = widget.getFocusedItem()?.item.completion;
    if (!selected?.ncforgeExplicit || !selected.documentation) return;
    const open = widget._isDetailsVisible();
    if (key.key === "ArrowLeft" && !open) return;
    event.preventDefault(); event.stopPropagation();
    // Monaco remembers expanded details across popups. Right always opens the preview.
    if (key.key === "ArrowRight" ? !open : open) editor.trigger("sql-assist", "toggleSuggestionDetails", {});
  });
  return { dispose() {
    resize.dispose();
    shown.dispose();
    hidden.dispose();
    focused.dispose();
    listNode.removeEventListener("pointermove", hover);
    preview.dispose();
    editorNode?.removeAttribute("data-sql-suggest-open");
    widget._layout = layout;
    controller._insertSuggestion = insert;
    if (renderer && renderRow) renderer.renderElement = renderRow;
    widget.showSuggestions = show;
    widget.getLayoutInfo = info;
    widget.showDetails = showDetails;
    widget.toggleDetails = toggleDetails;
    view.supportDynamicHeights = previousDynamic;
    geometry.hasDynamicHeight = previousDelegate;
    geometry.getDynamicHeight = previousHeight;
    node.classList.remove("dbx-suggest-fit");
    node.removeAttribute("data-sql-explicit");
    node.removeAttribute("data-sql-suggest-preview");
    node.removeAttribute("data-sql-expanded-fields");
    top.remove();
    panel.remove();
    footer.remove();
  } };
}
