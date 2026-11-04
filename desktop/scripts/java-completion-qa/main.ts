import report from "../../.cache/java-completion-after.json";
const state = { scenario: 0, calls: [] as unknown[], synced: "", delay: 0, lazyImports: false };
let callbackId = 0;
const callbacks = new Map<number, (value: unknown) => void>();
(window as any).__TAURI_INTERNALS__ = {
  transformCallback: (cb: (value: unknown) => void) => { callbacks.set(++callbackId, cb); return callbackId; },
  unregisterCallback: (id: number) => callbacks.delete(id),
  invoke: async (command: string, args: any) => {
    if (command === "plugin:event|listen") return 1;
    if (command === "get_config") return { lang_enabled: true, lang_auto_start: false };
    if (command === "lang_status") return { state: "ready", module: "gl", message: "", sourceFiles: 1, jarCount: 2 };
    if (command === "lang_notify") {
      state.synced = args.params.textDocument.text ?? applyChanges(state.synced, args.params.contentChanges ?? []);
      return;
    }
    if (command !== "lang_request") return null;
    state.calls.push(args);
    const c = report.cases[state.scenario];
    const synced = state.synced;
    if (state.delay) await new Promise(ok => setTimeout(ok, state.delay));
    if (args.method === "ncforge/typeCompletion") return c.raw?.data?.ncfType && c.expected.startsWith(args.params.prefix) ? [c.raw] : [];
    if (args.method === "ncforge/resolveTypeCompletion") return adjusted(c.resolved, args.params.position, c.source, synced);
    if (args.method === "textDocument/signatureHelp") return { signatures: [{ label: "append(String value)", parameters: [{ label: "String value" }] }], activeParameter: 0 };
    if (args.method === "completionItem/resolve") return adjusted(c.resolved, args.params.data?.qaPosition, c.source, synced);
    if (args.method !== "textDocument/completion") return null;
    const pos = args.params.position;
    const line = synced.split("\n")[pos.line] ?? "";
    const prefix = /[\p{L}\p{N}_$]+$/u.exec(line.slice(0, pos.character))?.[0] ?? "";
    const raw = c.raw;
    if (raw?.data?.ncfType) return { items: [] };
    if (!raw || !(raw.filterText ?? raw.insertText ?? raw.label).startsWith(prefix) || !prefix) return { items: [] };
    const item = adjusted(raw, pos, c.source, synced);
    if (state.lazyImports) delete item.additionalTextEdits;
    item.data = { ...item.data, qaPosition: pos };
    return { items: [item] };
  },
};
function applyChanges(text: string, changes: any[]) {
  for (const change of changes) {
    if (!change.range) { text = change.text; continue; }
    const lines = text.split("\n");
    const offset = (position: { line: number; character: number }) => lines.slice(0, position.line).reduce((n, line) => n + line.length + 1, 0) + position.character;
    text = text.slice(0, offset(change.range.start)) + change.text + text.slice(offset(change.range.end));
  }
  return text;
}
function adjusted(value: any, pos: any, original: string, synced: string) {
  const item = structuredClone(value);
  if (!item || !pos) return item;
  const source = original.split("/*cursor*/")[0].split("\n");
  const originalLine = source.length - 1;
  const originalCol = source.at(-1)!.length;
  const line = synced.split("\n")[pos.line] ?? "";
  const start = pos.character - (/[\p{L}\p{N}_$]+$/u.exec(line.slice(0, pos.character))?.[0].length ?? 0);
  if (item.textEdit?.range) item.textEdit.range = { start: { line: pos.line, character: start }, end: pos };
  for (const e of item.additionalTextEdits ?? []) {
    if (e.range.start.line === originalLine) {
      e.range.start.character += pos.character - originalCol;
      e.range.end.character += pos.character - originalCol;
    }
  }
  return item;
}
const [{ monaco }, store, lang, providers, templates, session, options] = await Promise.all([
  import("../../src/lib/monacoSetup"), import("../../src/lib/editorStore"), import("../../src/lib/lang"),
  import("../../src/lib/langProviders"), import("../../src/lib/liveTemplates"), import("../../src/lib/workspaceSession"), import("../../src/lib/javaSuggestOptions"),
]);
session.setSession({ root: "C:\\ws" });
providers.registerLangProviders();
templates.registerJavaTemplates();
await lang.initLang();
const model = store.openModel("C:\\ws\\gl\\CompletionDemo.java", { text: "", encoding: "UTF-8", hasBom: false, eol: "LF", lossless: true, size: 0, mtimeMs: 0 });
const editor = monaco.editor.create(document.getElementById("editor")!, {
  model, automaticLayout: true, minimap: { enabled: false }, stickyScroll: { enabled: true }, ...options.javaSuggestOptions,
});
(window as any).qa = {
  state, editor, model, cases: report.cases, store,
  reset: (index: number, text: string) => {
    editor.trigger("qa", "hideSuggestWidget", undefined);
    editor.setModel(model);
    state.scenario = index; state.calls = []; state.delay = 0; state.lazyImports = false;
    const offset = text.indexOf("/*cursor*/");
    model.setValue(text.replace("/*cursor*/", ""));
    editor.setPosition(model.getPositionAt(offset)); editor.focus();
  },
};
