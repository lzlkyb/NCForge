import { useLayoutEffect, type MutableRefObject } from "react";
import type * as Monaco from "monaco-editor";
import { monaco } from "../lib/monacoSetup";
import { sqlLanguageId } from "../lib/monacoSql";
import { useSqlDialect } from "./useSqlDialect";

export function useSqlEditorDialect(editor: MutableRefObject<Monaco.editor.IStandaloneCodeEditor | null>, tabId: string) {
  const dialect = useSqlDialect(tabId, true);
  useLayoutEffect(() => {
    const model = editor.current?.getModel();
    if (model && model.getLanguageId() !== sqlLanguageId(dialect)) monaco.editor.setModelLanguage(model, sqlLanguageId(dialect));
  }, [editor, tabId, dialect]);
}
