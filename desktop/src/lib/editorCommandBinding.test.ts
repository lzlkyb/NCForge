import { expect, it, vi } from "vitest";
import { bindEditorCommand } from "./editorCommandBinding";
import type { monaco } from "./monacoSetup";

it("uses editor-scoped actions and unregisters them when the owning editor is disposed", () => {
  const dispose = vi.fn(), action = vi.fn((_descriptor: monaco.editor.IActionDescriptor) => ({ dispose }));
  let destroyed!: () => void;
  const editor = { addAction: action, onDidDispose: (callback: () => void) => { destroyed = callback; } } as unknown as monaco.editor.IStandaloneCodeEditor;
  const save = vi.fn(); bindEditorCommand(editor, 2097, save, "保存当前文件");
  const descriptor = action.mock.calls[0]?.[0] as unknown as monaco.editor.IActionDescriptor;
  expect(descriptor).toMatchObject({ keybindings: [2097], precondition: "editorTextFocus" });
  descriptor.run(editor); expect(save).toHaveBeenCalledTimes(1);
  destroyed(); expect(dispose).toHaveBeenCalledTimes(1);
});
