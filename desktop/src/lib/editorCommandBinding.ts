import type { monaco } from "./monacoSetup";

/** addCommand uses a global binding; addAction also requires this editor's editorId. */
export function bindEditorCommand(editor: monaco.editor.IStandaloneCodeEditor, keybinding: number, run: () => void, label: string): void {
  const binding = editor.addAction({ id: `ncforge.key.${keybinding}`, label, keybindings: [keybinding], precondition: "editorTextFocus", run });
  // Monaco's dynamic actions remain registered until their returned disposable is released.
  editor.onDidDispose(() => binding.dispose());
}
