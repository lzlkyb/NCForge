import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import type { Cell, ColumnMeta } from "../../lib/dbApi";
import { copyText } from "../../lib/utils";
import "../../db-grid-inspector.css";

function prettyJson(s: string): string | null {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

/** 单元格详情：长文本 / CLOB 看全，可切 JSON 格式化。 */
export function CellDetail({ column, zh, row, value, empty, onClose }: {
  column: ColumnMeta | null;
  zh?: string;
  row: number | null;
  value: Cell;
  empty: boolean;
  onClose: () => void;
}) {
  const [view, setView] = useState<"raw" | "json" | "whitespace">("raw");
  const contentRef=useRef<HTMLPreElement>(null), infoId=useId();
  const text = value === null ? "" : String(value);
  const pretty = useMemo(()=>prettyJson(text),[text]);
  const onlyWhitespace=value!==null && text.length>0 && !/\S/.test(text);
  const valueInfo=value===null ? "NULL · 数据库空值" : text.length===0 ? "空字符串 · 0 字符" : `${onlyWhitespace ? "仅空白字符 · " : ""}${text.length} 字符`;
  const shown=view==="json" ? pretty ?? text : view==="whitespace" ? text.replace(/[\t\r\n ]/g,c=>c===" " ? "·" : c==="\t" ? "⇥" : c==="\r" ? "␍" : "↵\n") : text;
  useEffect(()=>setView("raw"),[column?.name,row,value]);
  useLayoutEffect(()=>{
    contentRef.current?.focus({preventScroll:true});
    contentRef.current?.scrollIntoView?.({block:"nearest",inline:"nearest"});
  },[]);
  return (
    <div className="dbx-detail" role="region" aria-label="单元格详情" onKeyDown={e=>{if(e.key==="Escape"){e.preventDefault();e.stopPropagation();onClose();}}}>
      <div className="hd">
        <div style={{ flex: 1, minWidth: 0 }}>
          {empty || !column ? (
            <span className="dbx-muted">选择单元格查看完整原值</span>
          ) : (
            <>
              <b>{column.name.toLowerCase()}</b>
              <div className="s" id={infoId}>
                {[zh, column.type, `第 ${row} 行`, valueInfo].filter(Boolean).join(" · ")}
              </div>
            </>
          )}
        </div>
        <button type="button" className="dbx-ibtn" aria-label="关闭详情" title="关闭详情 · Esc" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      {view!=="raw" && <div className="dbx-detail-note" role="status">{view==="json" ? "JSON 仅格式化展示" : "· 空格　⇥ 制表符　␍ 回车　↵ 换行"}；复制保留原值。</div>}
      <pre ref={contentRef} tabIndex={0} aria-label="单元格完整值" aria-describedby={!empty && column ? infoId : undefined} className={value === null ? "dbx-muted" : undefined}>{empty ? "" : value === null ? "NULL" : shown}</pre>
      <div className="ft">
        <button type="button" className="dbx-btn ghost" disabled={empty || value === null} onClick={() => void copyText(text, () => toast("已复制原值", "success"), (e) => toast(`复制失败：${e}`, "error"))}>
          <Icon name="copy" size={12} />
          复制原值
        </button>
        <button type="button" className="dbx-btn ghost" data-on={view==="json" || undefined} aria-pressed={view==="json"} disabled={empty || pretty===null} onClick={() => setView(view==="json" ? "raw" : "json")}>
          JSON 格式化
        </button>
        <button type="button" className="dbx-btn ghost" data-on={view==="whitespace" || undefined} aria-pressed={view==="whitespace"} disabled={empty || !/\s/.test(text)} onClick={()=>setView(view==="whitespace" ? "raw" : "whitespace")}>显示空白</button>
      </div>
    </div>
  );
}
