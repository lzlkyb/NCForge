import { useEffect, type RefObject } from "react";
import type { editor } from "monaco-editor";
import { codeDisplayOptionsOf, useEditorPrefs } from "../lib/editorPrefs";

/** Update display options in place, retaining SQL models, undo history, selection and scroll. */
export function useSqlDisplayPrefs(ref: RefObject<editor.IStandaloneCodeEditor | null>, text = "", label = ""): void {
  const { fontSize, fontFamily } = useEditorPrefs();
  useEffect(() => {
    ref.current?.updateOptions(codeDisplayOptionsOf({ fontSize, fontFamily }));
  }, [ref, fontSize, fontFamily, text, label]);
}
