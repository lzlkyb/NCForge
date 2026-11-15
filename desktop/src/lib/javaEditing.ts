import { monaco } from "./monacoSetup";
import { registerCommands } from "./commandRegistry";
import { context } from "./langProviderContext";
import { langRequest, langCapabilityEpoch } from "./lang";
import { toMonacoRange, type LspRange } from "./langConvert";
import { getEditorPrefs } from "./editorPrefs";
import { workspaceEpoch } from "./workspaceEpoch";
import { toast } from "../components/ui/toast";
import { completeJavaStatement, javaDocPlan, postfixExpression, POSTFIX_TEMPLATES } from "./javaEditingPlan";
import { findPasteImports } from "./javaPasteImports";
import { showJavaEditingDialog } from "./javaEditingDialogStore";
import { registerJavaParameterHints } from "./javaParameterHints";
import { runEditorCommand, currentIsJava, currentSelection } from "./editorActions";

let registered = false;
export function registerJavaEditingProviders(): void {
  if (registered) return;
  registered = true;
  monaco.languages.registerCompletionItemProvider("java", {
    triggerCharacters: ["."],
    provideCompletionItems: (model, position) => {
      const target = postfixExpression(model.getLineContent(position.lineNumber), position.column);
      if (!target) return null;
      const templates = POSTFIX_TEMPLATES.filter(template => template.key.startsWith(target.prefix) && (target.statement || template.key === "not"));
      return templates.length ? { suggestions: templates.map(template => ({ label: `.${template.key}`, filterText: model.getLineContent(position.lineNumber).slice(target.startColumn - 1, position.column - 1), sortText: `zz-postfix-${template.key}`, detail: template.detail,
        kind: monaco.languages.CompletionItemKind.Snippet, insertText: template.body(target.expression.replace(/[$}\\]/g, "\\$&")), insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range: new monaco.Range(position.lineNumber, target.startColumn, position.lineNumber, position.column) })) } : null;
    },
  });
  monaco.languages.registerDocumentRangeFormattingEditProvider("java", {
    provideDocumentRangeFormattingEdits: async (model, range, options, token) => {
      const version = model.getVersionId(), epoch = workspaceEpoch(), capability = langCapabilityEpoch();
      const current = () => !token.isCancellationRequested && !model.isDisposed() && model.getVersionId() === version && workspaceEpoch() === epoch && langCapabilityEpoch() === capability;
      const ctx = await context(model, { lineNumber: range.startLineNumber, column: range.startColumn });
      if (!ctx || !current()) return null;
      const result = await langRequest<{ range: LspRange; newText: string }[]>("textDocument/rangeFormatting", ctx.path, {
        range: { start: { line: range.startLineNumber - 1, character: range.startColumn - 1 }, end: { line: range.endLineNumber - 1, character: range.endColumn - 1 } },
        options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
      });
      return current() ? result?.map(edit => ({ range: toMonacoRange(edit.range), text: edit.newText })) ?? null : null;
    },
  });
  registerJavaParameterHints();
  const run = (id: string) => { runEditorCommand(id); };
  registerCommands([
    { id: "java.doc", title: "生成 JavaDoc（当前类 / 方法 / 字段）", run: () => run("ncforge.java.doc"), enabled: () => currentIsJava() && !currentSelection()?.readOnly },
    { id: "java.completeStatement", title: "补齐当前 Java 语句", hint: "Ctrl+Shift+Enter", run: () => run("ncforge.java.completeStatement"), enabled: () => currentIsJava() && !currentSelection()?.readOnly },
    { id: "java.templates", title: "管理 Java 代码模板与片段", run: () => showJavaEditingDialog({ kind: "templates" }) },
    { id: "java.pasteImports", title: "检查 Java 代码导入（当前选区或文件）", run: () => run("ncforge.java.pasteImports"), enabled: () => currentIsJava() && !currentSelection()?.readOnly },
  ]);
}

export function attachJavaEditing(editor: monaco.editor.IStandaloneCodeEditor): () => void {
  const editable = () => editor.getModel()?.getLanguageId() === "java" && !editor.getOption(monaco.editor.EditorOption.readOnly);
  const applyPlan = () => {
    const model = editor.getModel(), position = editor.getPosition();
    if (!model || !position || !editable()) return;
    const plan = javaDocPlan(model.getValue(), model.getOffsetAt(position));
    if (!plan) { toast("当前行不是可识别声明，或声明前已有文档；请将光标放到类、方法或字段声明行", "info"); return; }
    const at = model.getPositionAt(plan.start);
    editor.executeEdits("java-doc", [{ range: new monaco.Range(at.lineNumber, at.column, at.lineNumber, at.column), text: plan.text }]);
    editor.setPosition({ lineNumber: at.lineNumber + 1, column: model.getLineMaxColumn(at.lineNumber + 1) }); editor.focus();
  };
  const complete = () => {
    const model = editor.getModel(), position = editor.getPosition();
    if (!model || !position || !editable()) return;
    const prefs = getEditorPrefs(), text = completeJavaStatement(model.getLineContent(position.lineNumber), prefs.insertSpaces ? " ".repeat(prefs.tabSize) : "\t");
    if (!text) { toast("当前语句已完整，或无法安全补齐", "info"); return; }
    editor.executeEdits("java-complete-statement", [{ range: new monaco.Range(position.lineNumber, 1, position.lineNumber, model.getLineMaxColumn(position.lineNumber)), text }]); editor.focus();
  };
  const actions = [
    editor.addAction({ id: "ncforge.java.doc", label: "生成 JavaDoc", contextMenuGroupId: "ncforge.generate", contextMenuOrder: 1, precondition: "editorLangId == java && !editorReadonly", run: applyPlan }),
    editor.addAction({ id: "ncforge.java.completeStatement", label: "补齐当前语句", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter], contextMenuGroupId: "ncforge.generate", contextMenuOrder: 2, precondition: "editorLangId == java && !editorReadonly", run: complete }),
    editor.addAction({ id: "ncforge.java.templates", label: "管理 Java 代码模板", contextMenuGroupId: "ncforge.generate", contextMenuOrder: 3, precondition: "editorLangId == java", run: () => showJavaEditingDialog({ kind: "templates" }) }),
    editor.addAction({ id: "ncforge.java.pasteImports", label: "检查当前选区的导入", contextMenuGroupId: "ncforge.generate", contextMenuOrder: 4, precondition: "editorLangId == java && !editorReadonly", run: () => {
      const model = editor.getModel(), selection = editor.getSelection();
      if (model && selection) void findPasteImports(editor, selection.isEmpty() ? model.getValue() : model.getValueInRange(selection)).catch(reason => toast(`检查导入失败：${String(reason)}`, "warning"));
    } }),
  ];
  const paste = editor.onDidPaste(event => {
    const model = editor.getModel();
    if (model && editable() && getEditorPrefs().pasteImports) void findPasteImports(editor, model.getValueInRange(event.range)).catch(reason => toast(`检查导入失败：${String(reason)}`, "warning"));
  });
  return () => { actions.forEach(action => action.dispose()); paste.dispose(); };
}
