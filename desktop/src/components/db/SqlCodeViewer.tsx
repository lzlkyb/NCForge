import { lazy, Suspense, useRef, useState } from "react";
import { copyText } from "../../lib/utils";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import type { SqlCodeViewerApi } from "./SqlCodeViewerEditor";
import "./sql-code-viewer.css";

const ViewerEditor = lazy(() => import("./SqlCodeViewerEditor"));
export interface SqlCodeSection { label:string; text:string }

/** 展示原始数据库文本，不格式化或补写 CREATE；转到控制台也不自动执行。 */
export function SqlCodeViewer({ text, connId, label, source, sections = [] }: {
  text:string; connId?:string; label:string; source?:string; sections?:SqlCodeSection[];
}) {
  const api = useRef<SqlCodeViewerApi | null>(null);
  const [wrap, setWrap] = useState(false);
  const [section, setSection] = useState(0);
  const shown = sections[section]?.text ?? text;
  const currentLabel = sections[section]?.label ?? label;
  const [opening, setOpening] = useState(false);
  const open = async () => {
    if (opening || !connId) return;
    setOpening(true);
    try { const { newConsole } = await import("../../lib/dbActions"); await newConsole(connId, shown); }
    catch (error) { toast(`打开 SQL 控制台失败：${error}`, "error"); }
    finally { setOpening(false); }
  };
  return <section className="dbx-code-viewer" aria-label={label}>
    <div className="dbx-rtool dbx-code-toolbar">
      {sections.length > 1 ? <select aria-label="源码段" value={section} onChange={event=>setSection(Number(event.target.value))}>{sections.map((item,index)=><option key={item.label} value={index}>{item.label}</option>)}</select> : <span className="meta" title={source}>{label} · SQL · 只读</span>}
      <span className="dbx-sp" />
      <button type="button" className="dbx-btn ghost" aria-label="查找代码" title="查找 · Ctrl / ⌘ + F" onClick={()=>api.current?.find()}><Icon name="search" size={14}/></button>
      <button type="button" className="dbx-btn ghost" aria-label="自动换行" aria-pressed={wrap} title="自动换行" onClick={()=>setWrap(value=>!value)}><Icon name="sqlFormat" size={14}/></button>
      <button type="button" className="dbx-btn ghost" title={sections.length > 1 ? "复制全部源码，保留原文" : "复制完整原文"} onClick={()=>void copyText(text,()=>toast("已复制完整原文","success"),error=>toast(`复制失败：${error}`,"error"))}><Icon name="copy" size={14}/><span>{sections.length > 1 ? "复制全文" : "复制"}</span></button>
      {connId && <button type="button" className="dbx-btn ghost" aria-label="打开到 SQL 控制台" title="复制当前内容到新 SQL 控制台，不自动执行" disabled={opening} onClick={()=>void open()}><Icon name="terminal" size={14}/><span className="dbx-code-open-label">打开到 SQL 控制台</span></button>}
    </div>
    <Suspense fallback={<pre className="dbx-code-fallback" tabIndex={0} aria-label={`${currentLabel}（正在加载语法高亮）`}>{shown}</pre>}>
      <ViewerEditor text={shown} label={currentLabel} wrap={wrap} apiRef={api}/>
    </Suspense>
  </section>;
}
