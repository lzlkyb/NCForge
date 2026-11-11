// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { editor } from "monaco-editor";
import { expect, it, vi } from "vitest";
import { DEFAULT_PREFS, setEditorPrefs } from "../lib/editorPrefs";
import { useSqlDisplayPrefs } from "./useSqlDisplayPrefs";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("修改字体字号只更新显示选项，不更换模型或改动 SQL 换行策略", () => {
  setEditorPrefs(DEFAULT_PREFS);
  const updateOptions = vi.fn(), setModel = vi.fn(), dispose = vi.fn();
  const instance = { updateOptions, setModel, dispose } as unknown as editor.IStandaloneCodeEditor;
  function Probe({ text }: { text: string }) {
    const ref = useRef(instance);
    useSqlDisplayPrefs(ref, text);
    return null;
  }
  const host = document.createElement("div"), root = createRoot(host);
  try {
    act(() => root.render(<Probe text="first" />));
    expect(updateOptions).toHaveBeenLastCalledWith(expect.objectContaining({
      fontSize: 13, fontWeight: "400", fontLigatures: false,
      fontFamily: expect.stringContaining('"JetBrains Mono"'),
    }));
    act(() => { setEditorPrefs({ fontSize: 18, fontFamily: '"Custom Mono"', wordWrap: true }); });
    expect(updateOptions).toHaveBeenLastCalledWith({ fontSize: 18, lineHeight: 29,
      fontWeight: "400", fontLigatures: false,
      fontFamily: '"Custom Mono", "JetBrains Mono", "Noto Sans SC", Consolas, monospace' });
    updateOptions.mockClear();
    act(() => root.render(<Probe text="replacement model" />));
    expect(updateOptions).toHaveBeenCalledOnce();
    expect(setModel).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); setEditorPrefs(DEFAULT_PREFS); }
});
