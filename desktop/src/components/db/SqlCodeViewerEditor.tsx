import { useEffect, useRef, type MutableRefObject } from "react";
import type * as Monaco from "monaco-editor";
import { initMonaco } from "../../lib/monacoSetup";
import { sqlLanguageId } from "../../lib/monacoSql";
import type { SqlLanguage } from "sql-formatter";
import { useSqlDisplayPrefs } from "../../hooks/useSqlDisplayPrefs";
import { codeDisplayOptionsOf, getEditorPrefs } from "../../lib/editorPrefs";

export interface SqlCodeViewerApi { find:()=>void }

export default function SqlCodeViewerEditor({text,label,wrap,apiRef,dialect = "sql"}: {
  text:string; label:string; wrap:boolean; apiRef:MutableRefObject<SqlCodeViewerApi|null>; dialect?:SqlLanguage;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor|null>(null);
  useEffect(()=>{
    if (!host.current) return;
    const monaco = initMonaco();
    const model = monaco.editor.createModel(text,sqlLanguageId(dialect));
    let instance:Monaco.editor.IStandaloneCodeEditor;
    try {
      instance = monaco.editor.create(host.current, {
        model, theme:"nc-forge",readOnly:true,domReadOnly:true,ariaLabel:label,
        automaticLayout:true,...codeDisplayOptionsOf(getEditorPrefs()), minimap:{enabled:false},
        lineNumbers:"on",folding:true,showFoldingControls:"mouseover",
        guides:{indentation:true},matchBrackets:"always",scrollBeyondLastLine:false,
        wordWrap:"off",padding:{top:12,bottom:12},renderLineHighlight:"gutter",
        quickSuggestions:false,suggestOnTriggerCharacters:false,wordBasedSuggestions:"off","semanticHighlighting.enabled":true,
        links:false,stickyScroll:{enabled:false},
      });
    } catch (error) { model.dispose(); throw error; }
    editor.current = instance;
    apiRef.current = {find:()=>{instance.focus();void instance.getAction("actions.find")?.run();}};
    // 查看器独占临时模型，切对象与卸载时必须一起释放，不能加入 SQL 草稿模型缓存。
    return ()=>{apiRef.current=null;editor.current=null;instance.setModel(null);instance.dispose();model.dispose();};
    // Dialect changes update the existing model below, preserving selection and scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[text,label,apiRef]);
  useEffect(()=>{
    const model = editor.current?.getModel();
    if (model) initMonaco().editor.setModelLanguage(model,sqlLanguageId(dialect));
  },[dialect,text,label]);
  useSqlDisplayPrefs(editor,text,label);
  useEffect(()=>{editor.current?.updateOptions({wordWrap:wrap?"on":"off"});},[wrap,text,label]);
  return <div ref={host} className="dbx-code-editor"/>;
}
