import { SqlCodeViewer } from "./SqlCodeViewer";
import { useEffect, useState } from "react";
import { Icon } from "../ui/icon";
import { friendlyDbError } from "../../lib/db";
import { dbApi, type SourceLine } from "../../lib/dbApi";
import type { TableTab } from "../../lib/dbStore";
import { trackOperation } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";

/**
 * 库内源码（只读）：包规范与包体各一段，按 `user_source.type` 分成两组。
 *
 * 为什么不做编辑/编译：库里改包要走 `create or replace`，一旦拼错就是把生产包改坏；
 * 而二开代码的真源在工程里（SVN）。这里只回答「这段逻辑在库里还是 Java 里」。
 */
export function SourceView({ tab }: { tab: TableTab }) {
  const [lines, setLines] = useState<SourceLine[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [revision,setRevision]=useState(0);
  useEffect(() => {
    let live=true;setLines(null);
    setErr(null);
    void trackOperation(dbTaskSpec(`source:${tab.connId}:${tab.table}`,"读取数据库源码",tab.connId,tab.table,undefined,tab.id),()=>dbApi.source(tab.connId, tab.table)).then(
      (r) => {if(live) setLines(r.lines);},
      (e) => {if(live) setErr(friendlyDbError(e));},
    );
    return()=>{live=false;};
  }, [tab.id,tab.connId, tab.table,revision]);

  if (err) return <div className="dbx-err">{err}<button type="button" className="dbx-btn" onClick={()=>setRevision(v=>v+1)}>重新读取</button></div>;
  if (!lines) return <div className="dbx-empty"><Icon name="spinner" size={18} />读取中…</div>;
  if (lines.length === 0) {
    return <div className="dbx-empty">这个对象没有源码（序列、同义词这类只有定义），切到「DDL」看它的定义</div>;
  }

  // 按 type 连续分组：PACKAGE 一段、PACKAGE BODY 一段（后端已按 type 排好序）
  const groups: { type: string; rows: SourceLine[] }[] = [];
  for (const l of lines) {
    const last = groups[groups.length - 1];
    if (last && last.type === l.type) last.rows.push(l);
    else groups.push({ type: l.type, rows: [l] });
  }
  const all = lines.map((l) => l.text).join("");

  return <SqlCodeViewer key={`${tab.id}:${tab.table}`} text={all} connId={tab.connId} label="对象源码" sections={groups.map(group=>({label:group.type,text:group.rows.map(line=>line.text).join("")}))}/>;
}
