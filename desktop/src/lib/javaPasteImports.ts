import { monaco } from "./monacoSetup";
import { searchTypes } from "./typeSearch";
import { pathOfModel } from "./editorStore";
import { langReady, langRequest, flushDoc } from "./lang";
import { workspaceEpoch } from "./workspaceEpoch";
import { javaImportPlan, pastedJavaTypes } from "./javaEditingPlan";
import { showJavaEditingDialog, type ImportChoice, type JavaImportRequest } from "./javaEditingDialogStore";
export { showJavaEditingDialog, useJavaEditingDialog } from "./javaEditingDialogStore";
export type { JavaImportRequest } from "./javaEditingDialogStore";

export async function findPasteImports(editor: monaco.editor.IStandaloneCodeEditor, pasted: string): Promise<void> {
  const model = editor.getModel();
  if (!model || model.getLanguageId() !== "java" || editor.getOption(monaco.editor.EditorOption.readOnly)) return;
  const path = pathOfModel(model);
  if (!path) return;
  const version = model.getVersionId(), epoch = workspaceEpoch();
  const types = pastedJavaTypes(model.getValue(), pasted), choices: ImportChoice[] = [], notes: string[] = [];
  for (const simple of types) {
    const result = await searchTypes(simple, 60);
    if (model.isDisposed() || model.getVersionId() !== version || workspaceEpoch() !== epoch || editor.getModel() !== model) return;
    const names = [...new Map([...result.workspace, ...result.jars].filter(hit => hit.simple === simple || hit.name.split(".").pop() === simple)
      .map(hit => [hit.name, { name: hit.name, source: hit.file || hit.jar, library: !!hit.jar }])).values()];
    if (names.length) choices.push({ simple, names });
    else notes.push(`${simple} 未找到可导入类${result.indexing || result.jarsPending ? "（索引尚未完成）" : ""}`);
  }
  if (choices.length) showJavaEditingDialog({ kind: "imports", request: { editor, model, path, version, epoch, choices, notes } });
}

export async function applyPasteImports(request: JavaImportRequest, selected: string[]): Promise<number> {
  const { model, editor, version, epoch, path } = request;
  const current = () => !model.isDisposed() && model.getVersionId() === version && workspaceEpoch() === epoch && editor.getModel() === model && !editor.getOption(monaco.editor.EditorOption.readOnly);
  if (!current()) throw new Error("文件已切换或修改，请重新执行整理导入");
  const legal = new Map(request.choices.flatMap(choice => choice.names.map(item => [item.name, item] as const)));
  if (selected.some(name => !legal.has(name))) throw new Error("导入选择已过期");
  const plan = javaImportPlan(model.getValue(), selected);
  if (!plan) return 0;
  if (langReady()) {
    await flushDoc(path);
    for (const name of selected.filter(name => legal.get(name)?.library)) {
      // 复用全库补全的受控按需依赖加载，只使用当前查询返回的类名。
      await langRequest("ncforge/resolveTypeCompletion", path, { name, position: { line: 0, character: 0 } }, 20_000);
      if (!current()) throw new Error("载入依赖期间文件已修改，导入未应用");
    }
  }
  if (!current()) throw new Error("文件已修改，导入未应用");
  const position = model.getPositionAt(plan.start);
  model.pushEditOperations([], [{ range: { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column }, text: plan.text }], () => null);
  return selected.length;
}
