import type { editor } from "monaco-editor";
import { currentDocumentOutline } from "./documentOutlineModel";
import { getEditorPrefs, PREFS_EVENT } from "./editorPrefs";
import type { FlatSymbol } from "./symbols";

export function stickyJavaMethod(symbols: readonly FlatSymbol[], top: number): FlatSymbol | undefined {
  // Monaco caps sticky rows from the outside in, which would retain the class above the method.
  return symbols.reduce<FlatSymbol | undefined>((best, symbol) =>
    [6, 9, 12].includes(symbol.kind) && symbol.line < top && top <= symbol.endLine &&
      (!best || symbol.depth >= best.depth) ? symbol : best, undefined);
}

export function attachJavaStickyScope(view: editor.IStandaloneCodeEditor, path: string): () => void {
  const node = document.createElement("div");
  node.className = "wb-java-sticky";
  node.hidden = true;
  node.setAttribute("aria-hidden", "true");
  const widget: editor.IOverlayWidget = {
    getId: () => "ncforge.java.sticky",
    getDomNode: () => node,
    getPosition: () => ({ preference: { top: 0, left: 0 } }),
  };
  view.addOverlayWidget(widget);
  let symbols = currentDocumentOutline(path);
  const render = () => {
    const top = view.getVisibleRanges()[0]?.startLineNumber;
    const method = top && getEditorPrefs().stickyScroll ? stickyJavaMethod(symbols, top) : undefined;
    node.hidden = !method;
    if (!method) return;
    const layout = view.getLayoutInfo();
    const prefs = getEditorPrefs();
    node.style.width = `${layout.width - layout.verticalScrollbarWidth}px`;
    node.style.paddingInlineStart = `${layout.contentLeft}px`;
    node.style.height = `${Math.round(prefs.fontSize * 1.62)}px`;
    view.applyFontInfo(node);
    node.textContent = method.name;
  };
  let timer = 0;
  const listeners = [
    view.onDidScrollChange(render),
    view.onDidLayoutChange(render),
    view.onDidChangeConfiguration(render),
    view.onDidChangeModelContent(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { symbols = currentDocumentOutline(path); render(); }, 180);
    }),
  ];
  window.addEventListener(PREFS_EVENT, render);
  render();
  return () => {
    window.removeEventListener(PREFS_EVENT, render);
    window.clearTimeout(timer);
    for (const listener of listeners) listener.dispose();
    view.removeOverlayWidget(widget);
  };
}
