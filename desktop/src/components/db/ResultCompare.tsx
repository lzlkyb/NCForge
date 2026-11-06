import { useState } from "react";
import { compareResults, type ResultSnapshot } from "../../lib/dbResultTools";
import { Modal } from "../ui/Modal";
import { downloadText, toTsv } from "../../lib/resultExport";
import { Icon } from "../ui/icon";
import { ContextMenu, type ContextMenuItem } from "../workspace/ContextMenu";
import { toast } from "../ui/toast";

// 同一工作台可比较不同标签/连接的结果；快照不落盘，避免把业务数据隐式持久化。
let baseline: ResultSnapshot | null = null;
export function ResultCompare({ snapshot, related }: { snapshot: ResultSnapshot; related?: ContextMenuItem }) {
  const [open,setOpen] = useState(false), [keys,setKeys] = useState<string[]>([]), [saved,setSaved] = useState(false);
  const [reference,setReference] = useState<ResultSnapshot | null>(null);
  const [menu,setMenu] = useState<{x:number;y:number}|null>(null);
  let error = "", diff: ReturnType<typeof compareResults> | null = null;
  if (open && reference) { try { diff = compareResults(reference,snapshot,keys); } catch(e) { error = String(e instanceof Error ? e.message : e); } }
  return <>
    <button type="button" className="dbx-btn ghost" aria-label="结果工具" aria-haspopup="menu" aria-expanded={!!menu} title="固定对照、结果对比与关联记录" onClick={e => {const r=e.currentTarget.getBoundingClientRect();setMenu({x:r.left,y:r.bottom+4});}}><Icon name="more" size={14} /><span className="dbx-action-label">结果工具</span></button>
    {menu && <ContextMenu x={menu.x} y={menu.y} onClose={()=>setMenu(null)} items={[
      {label:saved ? "更新对照" : "固定为对照",icon:"copy",onSelect:()=>{baseline={...snapshot,columns:snapshot.columns.map(c=>({...c})),rows:snapshot.rows.map(r=>[...r])};setSaved(true);toast(`已固定对照 · ${snapshot.rows.length} 行`,"success");}},
      {label:"结果对比",icon:"layers",onSelect:()=>{setReference(baseline);setOpen(true);}},
      ...(related ? [{...related,separator:true}] : []),
    ]} />}
    {open && <Modal open ariaLabel="查询结果对比" onClose={() => setOpen(false)} className="modal-surface dbx-compare-dialog">
      <h2>查询结果对比</h2>
      {!reference ? <p>先在另一份结果上点击「固定为对照」。</p> : <>
        <p>对照：{reference.source} · {new Date(reference.at).toLocaleString()} · {reference.rows.length} 行</p><p>当前：{snapshot.source} · {new Date(snapshot.at).toLocaleString()} · {snapshot.rows.length} 行</p>
        <p className="dbx-muted">{reference.complete && snapshot.complete ? "比较两份完整查询结果" : "仅比较已读取的数据，不能代表全表差异"}</p>
        <details><summary>查看两份 SQL</summary><pre>{reference.sql}</pre><pre>{snapshot.sql}</pre></details>
        <fieldset><legend>选择唯一键（可以多选）</legend>{snapshot.columns.map(c => <label key={c.name}><input type="checkbox" checked={keys.includes(c.name)} onChange={e => setKeys(e.target.checked ? [...keys,c.name] : keys.filter(k => k!==c.name))} />{c.name}</label>)}</fieldset>
        {error && <p role="alert">{error}</p>}
        {diff && <><p role="status">新增 {diff.added.length} 行 · 删除 {diff.removed.length} 行 · 变化 {diff.changed.length} 行</p>
          <button type="button" className="dbx-btn" onClick={() => { const columns = [{name:"变化",type:"VARCHAR2",precision:0,scale:0},...reference.columns]; const rows = [...diff!.added.map(r => ["新增",...r]),...diff!.removed.map(r => ["删除",...r]),...diff!.changed.flatMap(r => [["修改前",...r.before],["修改后",...r.after]])]; downloadText("查询结果差异.tsv",toTsv(columns,rows)); }}>导出全部差异</button>
          <div className="dbx-diff-list">{diff.changed.slice(0,100).map((r,i) => <div key={i}>{reference.columns.filter((_,c) => r.before[c]!==r.after[c]).map(c => {const k=reference.columns.indexOf(c);return <p key={c.name}>{c.name}：{String(r.before[k] ?? "NULL")} → {String(r.after[k] ?? "NULL")}</p>;})}</div>)}
            {diff.added.slice(0,20).map((r,i) => <pre key={`a${i}`}>新增：{JSON.stringify(r)}</pre>)}{diff.removed.slice(0,20).map((r,i) => <pre key={`d${i}`}>删除：{JSON.stringify(r)}</pre>)}
          </div><p className="dbx-muted">屏幕最多展示 100 条修改、20 条新增和删除；导出包含全部差异。</p>
        </>}
      </>}
      <button type="button" className="dbx-btn" onClick={() => setOpen(false)}>关闭</button>
    </Modal>}
  </>;
}
