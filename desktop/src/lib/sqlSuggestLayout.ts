import { monaco } from "./monacoSetup";
import type { SqlCompletionItem } from "./sqlExplicitCompletion";

type Editor = monaco.editor.IStandaloneCodeEditor;
type Size = { width: number; height: number };
type SuggestionModel = { items: readonly { textLabel: string; completion: SqlCompletionItem }[] };

// Monaco 0.52 exposes completion content, but has no public option for popup width
// or wrapping rows. Keep its virtual list, focus, placement and resize handles.
interface SuggestWidget {
  element: { domNode: HTMLElement; size: Size };
  onDidShow(listener: () => void): monaco.IDisposable;
  getLayoutInfo(): { defaultSize: Size; itemHeight: number };
  _layout(size?: Size): void;
  _completionModel?: SuggestionModel;
  showSuggestions(model: SuggestionModel, index: number, frozen: boolean, auto: boolean, noFocus: boolean): void;
  getFocusedItem(): { item: { completion: SqlCompletionItem } } | undefined;
  _isDetailsVisible(): boolean;
  _list: {
    contentHeight: number;
    view: {
      supportDynamicHeights: boolean;
      virtualDelegate: { hasDynamicHeight?: () => boolean; getDynamicHeight?: () => number | null };
      rerender(): void;
    };
  };
}

export function wireSqlSuggestLayout(editor: Editor): monaco.IDisposable {
  const controller = editor.getContribution("editor.contrib.suggestController") as unknown as
    { widget?: { value: SuggestWidget } } | null;
  const widget = controller?.widget?.value;
  const view = widget?._list?.view;
  const listNode = widget?.element?.domNode.querySelector<HTMLElement>(":scope > .tree");
  if (!widget || !view?.virtualDelegate || !view.rerender || !widget._layout || !listNode) return { dispose() {} };

  const node = widget.element.domNode;
  const canvas = node.ownerDocument.createElement("canvas").getContext("2d");
  const layout = widget._layout;
  const show = widget.showSuggestions;
  widget.showSuggestions = (model, index, frozen, auto, noFocus) => {
    const explicit = model.items[index]?.completion.ncforgeExplicit === true;
    node.toggleAttribute("data-sql-explicit", explicit);
    // Monaco dispatches Enter/Tab only when a row has focus. Withhold initial focus for edits
    // such as JOIN and expanding *, and let the native arrow/mouse controls select them.
    show.call(widget, model, index, frozen, auto, noFocus || explicit);
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
    if (needsMeasurement) widget._layout(widget.element.size);
  });
  const preview = editor.onKeyDown(event => {
    const key = event.browserEvent;
    if (!["ArrowRight", "ArrowLeft"].includes(key.key) || key.shiftKey || key.altKey || key.ctrlKey || key.metaKey || key.isComposing) return;
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
    preview.dispose();
    widget._layout = layout;
    widget.showSuggestions = show;
    view.supportDynamicHeights = previousDynamic;
    geometry.hasDynamicHeight = previousDelegate;
    geometry.getDynamicHeight = previousHeight;
    node.classList.remove("dbx-suggest-fit");
    node.removeAttribute("data-sql-explicit");
  } };
}
