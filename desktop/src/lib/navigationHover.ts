import { monaco } from "./monacoSetup";
import { captureNavigation, openNavigation, type NavigationIntent } from "./navigationService";
import { NAVIGATION_LABELS, qualifiedTypeAt, type NavigationKind } from "./navigationTargets";
import { copyText } from "./utils";
import { toast } from "../components/ui/toast";

const COMMAND = "ncforge.navigation";
let registered = false;
export function registerNavigationCommand() {
  if (registered) return;
  registered = true;
  monaco.editor.registerCommand(COMMAND, (_accessor, kind: NavigationKind, intent: NavigationIntent, preview = false) => {
    if (!Object.prototype.hasOwnProperty.call(NAVIGATION_LABELS, kind) || !intent || typeof intent.uri !== "string" || !Number.isSafeInteger(intent.line) || !Number.isSafeInteger(intent.column) || intent.line < 1 || intent.column < 1) return;
    void openNavigation(kind, intent, preview);
  });
}
export function navigationHover(model: ReturnType<typeof monaco.editor.createModel>, position: { lineNumber: number; column: number }, documentation: string): monaco.IMarkdownString {
  const word = model.getWordAtPosition(position), kinds: NavigationKind[] = ["definition"];
  const row = model.getLineContent(position.lineNumber), after = row.slice((word?.endColumn ?? position.column) - 1);
  const method = /^\s*\(/.test(after) || /\b(?:public|protected|private)\b[^\n]*\(/.test(documentation);
  const type = /^[A-Z_$]/.test(word?.word ?? "") || /\b(?:class|interface|enum)\b/.test(documentation);
  if (method || type) kinds.push("implementation");
  if (method) kinds.push("super");
  if (!type && !method) kinds.push("type");
  kinds.push("references");
  if (type && (/\binterface\b/.test(documentation) || row.includes("lookup"))) kinds.push("assembly");
  const intent = captureNavigation(model, position.lineNumber, position.column);
  const link = (kind: NavigationKind, label = NAVIGATION_LABELS[kind], preview = false) => `[${label}](command:${COMMAND}?${encodeURIComponent(JSON.stringify([kind, intent, preview]))})`;
  return { value: kinds.map(kind => link(kind)).join(" · ") + "\n\n" + link("definition", "就地预览", true), isTrusted: { enabledCommands: [COMMAND] } };
}
export function attachNavigationActions(editor: monaco.editor.IStandaloneCodeEditor) {
  const actions = [
    editor.addAction({ id: "ncforge.superMethod", label: "打开父方法", precondition: "editorLangId == java", contextMenuGroupId: "navigation", contextMenuOrder: 1.7, run: () => openNavigation("super") }),
    editor.addAction({ id: "ncforge.ncAssembly", label: "查看 NC 服务装配", precondition: "editorLangId == java", contextMenuGroupId: "navigation", contextMenuOrder: 1.8, run: () => openNavigation("assembly") }),
    editor.addAction({ id: "ncforge.copyQualifiedName", label: "复制完整类名", precondition: "editorLangId == java", contextMenuGroupId: "navigation", contextMenuOrder: 1.9, run: () => {
      const model = editor.getModel(), pos = editor.getPosition();
      const name = model && pos ? qualifiedTypeAt(model.getValue(), pos.lineNumber, pos.column) : null;
      if (!name) { toast("请把光标放到类名或接口名上", "info"); return; }
      if (!name.includes(".")) { toast("当前类名的包尚未确定，请先通过声明跳转确认来源。", "info"); return; }
      return copyText(name, () => toast("已复制完整类名", "success"), error => toast(`复制失败：${error}`, "error"));
    } }),
  ];
  return () => actions.forEach(action => action.dispose());
}
