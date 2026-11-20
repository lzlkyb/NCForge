import { monaco } from "./monacoSetup";
import type { SqlAssistPreview, SqlPreviewIcon } from "./sqlAssistPreview";
import type { SqlCompletionItem } from "./sqlExplicitCompletion";

type Editor = monaco.editor.IStandaloneCodeEditor;
export interface SqlAssistChoice {
  label: string;
  detail?: string;
  preview: SqlAssistPreview;
  apply?: (editor: Editor) => void;
}
interface Picker {
  offset: number;
  choices: SqlAssistChoice[];
  current: () => boolean;
  contextCurrent: () => boolean;
  shown: boolean;
}
const pickers = new WeakMap<monaco.editor.ITextModel, Picker>();

export function hasSqlAssistPicker(model: monaco.editor.ITextModel): boolean {
  return pickers.get(model)?.current() ?? false;
}

export function sqlAssistPickerChoices(model: monaco.editor.ITextModel, position: monaco.Position) {
  const picker = pickers.get(model);
  if (!picker) return;
  if (!picker.current() || model.getOffsetAt(position) !== picker.offset) { pickers.delete(model); return; }
  const suggestions: SqlCompletionItem[] = picker.choices.map((choice, index) => ({
    label: { label: choice.label, description: choice.detail },
    kind: monaco.languages.CompletionItemKind.Snippet,
    insertText: "", range: monaco.Range.fromPositions(position, position),
    sortText: String(index).padStart(4, "0"), preselect: index === 0,
    ncforgeExplicit: true,
    ncforgePreview: { ...choice.preview, current: picker.current },
    ncforgePicker: true,
    ncforgeApply: choice.apply && (editor => { if (picker.contextCurrent()) choice.apply!(editor); }),
  }));
  return { suggestions };
}

function suggestController(editor: Editor) {
  return editor.getContribution?.("editor.contrib.suggestController") as unknown as {
    cancelSuggestWidget?: () => void;
    model?: { trigger(options: { auto: boolean; retrigger: boolean }): void };
  } | null;
}

function refreshPicker(editor: Editor, picker: Picker) {
  if (!picker.current()) return;
  suggestController(editor)?.model?.trigger({ auto: false, retrigger: true });
}

export function markSqlAssistPickerShown(model: monaco.editor.ITextModel | null, editor?: Editor, loadingRow = false) {
  const picker = model && pickers.get(model);
  if (!picker) return;
  picker.shown = true;
  const preview = picker.choices[0]?.preview;
  // Let Monaco reveal the first list before retriggering, so it clears its pending loading timer.
  if (editor && loadingRow && (!preview || !("status" in preview) || preview.status !== "loading")) {
    queueMicrotask(() => refreshPicker(editor, picker));
  }
}

export function dismissSqlAssistPicker(model: monaco.editor.ITextModel | null) {
  if (model) pickers.delete(model);
}

export async function openSqlAssistPicker(editor: Editor, title: string, icon: SqlPreviewIcon, contextCurrent: () => boolean,
  load: (current: () => boolean) => Promise<SqlAssistChoice[]>) {
  const model = editor.getModel(), position = editor.getPosition();
  if (!model || !position) return;
  const pending = { label: "正在准备预览…", preview: { title, icon, status: "loading", text: "正在读取所需信息…" } } as const;
  const picker: Picker = { offset: model.getOffsetAt(position), choices: [pending], shown: false, contextCurrent,
    current: () => pickers.get(model) === picker && contextCurrent() };
  suggestController(editor)?.cancelSuggestWidget?.();
  pickers.set(model, picker);
  editor.trigger("sql-assist", "editor.action.triggerSuggest", {});
  try {
    const choices = await load(picker.current);
    if (!picker.current()) return;
    picker.choices = choices.length ? choices : [{ label: "暂无可用选项", preview: { title, icon, status: "empty", text: "当前上下文暂无可用的 SQL 操作" } }];
  } catch (error) {
    if (!picker.current()) return;
    picker.choices = [{ label: "暂时无法预览", preview: { title, icon, status: "error", text: error instanceof Error ? error.message : "请确认当前连接后重试" } }];
  }
  if (picker.shown) refreshPicker(editor, picker);
}
