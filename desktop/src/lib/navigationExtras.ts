import { monaco } from "./monacoSetup";
import { captureNavigation, openQualifiedType } from "./navigationService";
import { pathOfModel } from "./editorStore";
import { currentDocumentOutline, OUTLINE_READY } from "./documentOutlineModel";
import { registerCommands } from "./commandRegistry";
import { currentIsJava } from "./editorActions";
import { workspaceEpoch } from "./workspaceEpoch";
import { javaTestLensTargets } from "./javaRunTargets";
import { getSession, setSession } from "./workspaceSession";
import { errorToast } from "./errorToast";
const KEY = "ncforge-code-relations-lenses";
let registered = false;
const changes = new Set<() => void>();
const notify = () => changes.forEach(callback => callback());
const backgroundIntent = (model: Parameters<typeof captureNavigation>[0], line: number, column: number) => {
  const intent = captureNavigation(model, line, column);
  // Providers run for inactive models too; the eventual click determines the editor group.
  delete intent.group;
  return intent;
};
export function relationLensesEnabled(): boolean { try { return localStorage.getItem(KEY) === "true"; } catch { return false; } }
export function toggleRelationLenses() { try { localStorage.setItem(KEY, String(!relationLensesEnabled())); } catch { return; } notify(); }
export function registerNavigationExtras() {
  if (registered) return;
  registered = true;
  monaco.editor.registerCommand("ncforge.openQualifiedType", (_accessor, name: string, intent: Parameters<typeof openQualifiedType>[1]) => { if (typeof name === "string" && intent) void openQualifiedType(name, intent); });
  monaco.editor.registerCommand("ncforge.runTestLens", async (_accessor, intent: Parameters<typeof openQualifiedType>[1], target: string) => {
    const model = intent && monaco.editor.getModel(monaco.Uri.parse(intent.uri));
    if (!model || model.isDisposed() || model.getVersionId() !== intent.version || workspaceEpoch() !== intent.epoch || !/^[\w.$]+#[\w$]+$/.test(target)) return;
    const path = pathOfModel(model);
    if (!path || getSession().tabs.find(tab => tab.path === path)?.readOnly) return;
    try {
      const { configureJavaRun, runJava } = await import("./javaRun");
      if (workspaceEpoch() !== intent.epoch || model.isDisposed() || model.getVersionId() !== intent.version) return;
      const config = { path, mode: "test" as const, classes: target, args: "", extraClasspath: "" };
      configureJavaRun(config);
      setSession({ panelOpen: true, panelTab: "tests" });
      await runJava(config);
    } catch (error) { errorToast("运行测试", error); }
  });
  monaco.languages.registerLinkProvider(["xml", "properties"], {
    provideLinks: (model, token) => {
      if (model.getValueLength() > 2 * 1024 * 1024 || token.isCancellationRequested) return null;
      const text = model.getValue(), links: monaco.languages.ILink[] = [];
      const pattern = /["'=]\s*((?:[a-zA-Z_$][\w$]*\.)+[A-Z_$][\w$]*(?:\$[\w$]+)?)\s*(?=["'\s<]|$)/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) && links.length < 500) {
        const start = model.getPositionAt(match.index + match[0].indexOf(match[1])), end = model.getPositionAt(match.index + match[0].indexOf(match[1]) + match[1].length);
        links.push({ range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), url: monaco.Uri.parse(`command:ncforge.openQualifiedType?${encodeURIComponent(JSON.stringify([match[1], backgroundIntent(model, start.lineNumber, start.column)]))}`), tooltip: "打开完整类名对应的源码或依赖类" });
      }
      return { links };
    },
  });
  const provider: monaco.languages.CodeLensProvider = {
    onDidChange: callback => { const changed = () => callback(provider); changes.add(changed); return { dispose: () => changes.delete(changed) }; },
    provideCodeLenses: (model, token) => {
      const path = pathOfModel(model);
      if (!path || !relationLensesEnabled() || token.isCancellationRequested) return { lenses: [], dispose() {} };
      const symbols = currentDocumentOutline(path).filter(symbol => [5, 6, 9, 10, 11].includes(symbol.kind)).slice(0, 100);
      const testTargets = javaTestLensTargets(model.getValue());
      const lenses: monaco.languages.CodeLens[] = [];
      for (const symbol of symbols) {
        const intent = backgroundIntent(model, symbol.line, symbol.column), range = new monaco.Range(symbol.line, 1, symbol.line, 1);
        for (const [kind, title] of [["references", "查引用"], ["implementation", "查实现"]]) lenses.push({ range, command: { id: "ncforge.navigation", title, arguments: [kind, intent] } });
        if (symbol.kind === 6) lenses.push({ range, command: { id: "ncforge.navigation", title: "打开父方法", arguments: ["super", intent] } });
        const target = testTargets.get(`${symbol.line}:${symbol.column}`);
        if (target) lenses.push({ range, command: { id: "ncforge.runTestLens", title: "运行测试", arguments: [intent, target] } });
      }
      return { lenses, dispose() {} };
    },
  };
  monaco.languages.registerCodeLensProvider("java", provider);
  // Both listeners are application singletons. No scanning or semantic requests while disabled.
  window.addEventListener(OUTLINE_READY, notify);
  registerCommands([{ id: "navigation.codeLens", title: "切换代码上方的引用 / 实现 / 测试提示", enabled: currentIsJava, run: toggleRelationLenses }]);
}
