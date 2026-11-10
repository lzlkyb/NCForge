import { useEffect, useRef, type MutableRefObject } from "react";
import type * as Monaco from "monaco-editor";
import { conf, language } from "monaco-editor/esm/vs/basic-languages/sql/sql.js";
import { initMonaco } from "../../lib/monacoSetup";

const VIEW_LANGUAGE = "ncforge-sql-view";
let registered = false;

export interface SqlCodeViewerApi { find:()=>void }

export default function SqlCodeViewerEditor({text,label,wrap,apiRef}: {
  text:string; label:string; wrap:boolean; apiRef:MutableRefObject<SqlCodeViewerApi|null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor|null>(null);
  useEffect(()=>{
    if (!host.current) return;
    const monaco = initMonaco();
    if (!registered) {
      monaco.languages.register({id:VIEW_LANGUAGE});
      monaco.languages.setLanguageConfiguration(VIEW_LANGUAGE,conf);
      // 沿用SQL注释、字符串和引号标识符规则，仅补Oracle类型；不改写查询编辑器的语言服务。
      monaco.languages.setMonarchTokensProvider(VIEW_LANGUAGE,{
        ...language,
        tokenizer:{...language.tokenizer, sqlRoot:language.tokenizer.root,
          root:[{include:"@comments"},{include:"@whitespace"},{include:"@strings"},{include:"@complexIdentifiers"},
            [/\b(?:VARCHAR2|NVARCHAR2|VARCHAR|CHAR|NCHAR|NUMBER|NUMERIC|DECIMAL|INTEGER|INT|FLOAT|BINARY_FLOAT|BINARY_DOUBLE|DATE|TIMESTAMP|INTERVAL|CLOB|NCLOB|BLOB|RAW|LONG|ROWID|UROWID|BOOLEAN)\b/i,"type"],
            {include:"@sqlRoot"}],
        },
      });
      registered = true;
    }
    const model = monaco.editor.createModel(text,VIEW_LANGUAGE);
    let instance:Monaco.editor.IStandaloneCodeEditor;
    try {
      instance = monaco.editor.create(host.current, {
        model, theme:"nc-forge",readOnly:true,domReadOnly:true,ariaLabel:label,
        automaticLayout:true,fontSize:13,lineHeight:21, minimap:{enabled:false},
        lineNumbers:"on",folding:true,showFoldingControls:"mouseover",
        guides:{indentation:true},matchBrackets:"always",scrollBeyondLastLine:false,
        wordWrap:"off",padding:{top:12,bottom:12},renderLineHighlight:"gutter",
        quickSuggestions:false,suggestOnTriggerCharacters:false,wordBasedSuggestions:"off",
        links:false,stickyScroll:{enabled:false},
      });
    } catch (error) { model.dispose(); throw error; }
    editor.current = instance;
    apiRef.current = {find:()=>{instance.focus();void instance.getAction("actions.find")?.run();}};
    // 查看器独占临时模型，切对象与卸载时必须一起释放，不能加入 SQL 草稿模型缓存。
    return ()=>{apiRef.current=null;editor.current=null;instance.setModel(null);instance.dispose();model.dispose();};
  },[text,label,apiRef]);
  useEffect(()=>{editor.current?.updateOptions({wordWrap:wrap?"on":"off"});},[wrap,text,label]);
  return <div ref={host} className="dbx-code-editor"/>;
}
