// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { attachErrorLens } from "./errorLens";
import { setCodeDiags, type CodeDiag } from "./diagStore";
import { DEFAULT_PREFS, setEditorPrefs } from "./editorPrefs";

vi.mock("./monacoSetup", () => ({ monaco: { Range: class {} } }));
vi.mock("./editorStore", () => ({ pathOfModel: (model: { path: string }) => model.path }));
afterEach(() => { setCodeDiags([]); setEditorPrefs(DEFAULT_PREFS); });

it("unrelated diagnostics do not rebuild current editor decorations, but own changes and preferences do", () => {
  setEditorPrefs({ errorLens: true });
  const diag: CodeDiag = { path: "C:\\w\\A.java", line: 1, column: 1, severity: "warning", message: "unused" };
  setCodeDiags([diag]);
  const collection = { set: vi.fn(), clear: vi.fn() };
  const editor = { getModel: () => ({ path: diag.path }), createDecorationsCollection: vi.fn(() => collection), onDidChangeModel: vi.fn(() => ({ dispose: vi.fn() })) };
  const model = { path: diag.path }; editor.getModel = () => model;
  const stop = attachErrorLens(editor as unknown as Parameters<typeof attachErrorLens>[0]);
  try {
    expect(collection.set).toHaveBeenCalledOnce();
    setCodeDiags([{ ...diag }, { ...diag, path: "C:\\w\\B.java" }]);
    expect(collection.set).toHaveBeenCalledOnce(); expect(collection.clear).not.toHaveBeenCalled();
    setCodeDiags([{ ...diag, message: "different" }]);
    expect(collection.set).toHaveBeenCalledTimes(2);
    setEditorPrefs({ errorLens: false });
    expect(collection.clear).toHaveBeenCalledTimes(2);
  } finally { stop(); }
});
