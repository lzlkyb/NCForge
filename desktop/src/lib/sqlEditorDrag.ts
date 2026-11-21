import { monaco } from "./monacoSetup";
import { edgeSpeed, trackSelectionDrag } from "./dragEdgeScroll";

export function wireSqlEditorDrag(editor: monaco.editor.IStandaloneCodeEditor) {
  const container = editor.getContainerDomNode?.(), win = container?.ownerDocument.defaultView;
  if (!container || !win || !editor.getTargetAtClientPoint) return { dispose() {} };
  let stop: (() => void) | undefined;
  const cancel = () => { stop?.(); stop = undefined; };
  const down = (event: PointerEvent) => {
    cancel();
    if (event.button !== 0 || event.pointerType !== "mouse" || event.altKey || event.ctrlKey || event.metaKey) return;
    const model = editor.getModel(), node = editor.getDomNode(), target = editor.getTargetAtClientPoint(event.clientX, event.clientY);
    if (!model || !node || !target?.position || ![monaco.editor.MouseTargetType.CONTENT_TEXT, monaco.editor.MouseTargetType.CONTENT_EMPTY].includes(target.type)) return;
    const selection = editor.getSelection();
    if (!event.shiftKey && selection && !selection.isEmpty() && selection.containsPosition(target.position) && editor.getOption(monaco.editor.EditorOption.dragAndDrop)) return;
    const anchor = event.shiftKey && selection ? selection.getSelectionStart() : target.position;
    let point = event, speed = 0;
    const band = Math.max(12, editor.getOption(monaco.editor.EditorOption.lineHeight));
    let scrollPosition = editor.getScrollTop();
    stop = trackSelectionDrag(win, event.pointerId, move => {
      const rect = node.getBoundingClientRect();
      if (!rect.height || editor.getModel() !== model) { cancel(); return false; }
      point = move;
      speed = edgeSpeed(move.clientY, rect.top, rect.bottom, Math.min(band, rect.height / 3));
      if (!speed) return false;
      scrollPosition = editor.getScrollTop();
      // Monaco still handles the interior gesture. At the edge only one loop may write the selection.
      move.stopPropagation();
      return true;
    }, seconds => {
      const rect = node.getBoundingClientRect();
      if (!rect.height || editor.getModel() !== model || model.isDisposed()) { cancel(); return; }
      const max = Math.max(0, editor.getScrollHeight() - editor.getLayoutInfo().height);
      scrollPosition = Math.max(0, Math.min(max, scrollPosition + speed * seconds));
      editor.setScrollTop(scrollPosition, monaco.editor.ScrollType.Immediate);
      const x = Math.max(rect.left + editor.getLayoutInfo().contentLeft + 1, Math.min(rect.right - editor.getLayoutInfo().verticalScrollbarWidth - 1, point.clientX));
      const y = Math.max(rect.top + 1, Math.min(rect.bottom - editor.getLayoutInfo().horizontalScrollbarHeight - 1, point.clientY));
      const last = model.getLineCount();
      const end = speed < 0 && scrollPosition === 0 ? { lineNumber: 1, column: 1 }
        : speed > 0 && scrollPosition === max ? { lineNumber: last, column: model.getLineMaxColumn(last) }
        : editor.getTargetAtClientPoint(x, y)?.position;
      if (end) {
        const next = monaco.Selection.fromPositions(anchor, end);
        if (!editor.getSelection()?.equalsSelection(next)) editor.setSelection(next);
      }
    });
  };
  container.addEventListener("pointerdown", down, true);
  const modelChange = editor.onDidChangeModel(cancel);
  return { dispose() { cancel(); modelChange.dispose(); container.removeEventListener("pointerdown", down, true); } };
}
