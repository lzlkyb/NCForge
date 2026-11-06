import type { monaco } from "./monacoSetup";
import { getModel, getViewState, saveViewState } from "./editorStore";
import type { EditorGroupId } from "./editorGroups";

type ViewState = monaco.editor.ICodeEditorViewState | null;
const views = new Map<string, { model: ReturnType<typeof getModel>; state: ViewState }>();
const key = (group: EditorGroupId, path: string) => `${group}:${path.toLowerCase()}`;
export function readGroupView(group: EditorGroupId | undefined, path: string): ViewState {
  const cached = group ? views.get(key(group, path)) : undefined;
  return cached && cached.model === getModel(path) ? cached.state : getViewState(path);
}
/** A shared text model still needs distinct selection/scroll snapshots for its two views. */
export function storeGroupView(group: EditorGroupId | undefined, path: string, state: ViewState) {
  saveViewState(path, state);
  const model = getModel(path);
  if (!group || !model) return;
  const id = key(group, path); views.delete(id); views.set(id, { model, state });
  if (views.size > 120) views.delete(views.keys().next().value!);
}
