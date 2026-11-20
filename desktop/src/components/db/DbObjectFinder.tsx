import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { identifier } from "../../lib/dbConditions";
import { connOf, rtOf, useConnRt, useDbConns, useDbSelector } from "../../lib/dbStore";
import { newConsole, openTable, refreshMeta } from "../../lib/dbActions";
import { ensureConnected } from "../../lib/dbConfirm";
import { dbApi, type DbObject, ENV_LABEL } from "../../lib/dbApi";
import { toast } from "../ui/toast";
import { trackOperation } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
import { Icon } from "../ui/icon";
import { friendlyDbError } from "../../lib/db";
import { isImeComposing } from "../../lib/utils";
import { isTableObject, rankDbObjects, rememberDbObject } from "../../lib/dbObjectRanking";
import { connectionKey } from "../../lib/dbResultContext";

export function DbObjectFinder({ connId, onClose }: { connId:string|null; onClose:()=>void }) {
  const db = {
    conns: useDbConns(),
    active: useDbSelector((s) => s.active),
    // 「插入当前 SQL」只在活动标签是同一连接的 SQL 标签时可用；订阅它，标签换连接时按钮跟着变
    activeSqlConn: useDbSelector((s) => {
      const t = s.tabs.find((x) => x.id === s.active);
      return t?.kind === "sql" ? t.connId : undefined;
    }),
  };
  const [scope,setScope] = useState(connId ?? db.conns[0]?.id ?? ""), [query,setQuery] = useState(""), [index,setIndex] = useState(0), [loading,setLoading] = useState(false);
  const rt = useConnRt(scope);
  const conn = connOf(scope), schema = rt.currentSchema ?? rt.info?.schema;
  const [objectState,setObjects]=useState({scope:"",schema:undefined as string | undefined,rows:[] as DbObject[],loading:false,error:"",revision:0});
  const objects=objectState.scope === scope && objectState.schema === schema ? objectState.rows : EMPTY_OBJECTS;
  const actionLock=useRef(false);
  useEffect(()=>{let live=true;setObjects(v=>({...v,scope,schema,rows:[],loading:rt.status==="connected",error:""}));if(rt.status==="connected") void trackOperation(dbTaskSpec(`objects:${scope}`,"读取数据库对象清单",scope,"对象查找"),()=>dbApi.objects(scope)).then(r=>{if(live) setObjects(v=>({...v,rows:r.objects,loading:false}));},e=>{if(live) setObjects(v=>({...v,loading:false,error:friendlyDbError(e)}));});return()=>{live=false;};},[scope,schema,rt.status,rt.tablesAt,objectState.revision]);
  const names = useMemo(() => [...(rt.tables ?? Object.keys(rt.schema?.tables ?? {}).map(name => ({name,kind:"TABLE" as const}))),...objects.map(o=>({name:o.name,kind:o.type}))], [rt.tables, rt.schema, objects]);
  // 打分与排序只在清单 / 关键词变化时算：上下键移动选中项也会重渲染，不能每次都重扫几千个对象。
  const hits = useMemo(() => rankDbObjects(names, query, rt.ncNames ?? {}, conn, schema), [names, query, rt.ncNames, conn, schema]);
  const chosen = hits[Math.min(index,Math.max(0,hits.length-1))];
  const pick = async (mode:"data"|"struct"|"insert"|"name", target=chosen) => {
    if (!target || actionLock.current) return;
    actionLock.current=true;
    try {
      const name=identifier(target.name.toLowerCase());
      if(mode==="name") {
        if (db.activeSqlConn !== scope) return;
        window.dispatchEvent(new CustomEvent("ncforge-db-insert-name",{detail:{tabId:db.active,text:name}}));
      } else if (mode === "insert") {
        if (!isTableObject(target) || !await newConsole(scope,`select * from ${name}`)) return;
      }
      else {
        if (!(await ensureConnected(scope))) return;
        const live = rtOf(scope);
        if (connectionKey(connOf(scope)) !== connectionKey(conn) || schema !== undefined && schema !== (live.currentSchema ?? live.info?.schema)) {
          toast("连接或 Schema 已变化，请重新选择对象。", "warning");
          return;
        }
        if (!isTableObject(target)) {
          if (await openTable(scope,target.name,"source",target.kind) === false) return;
        } else if (await openTable(scope,target.name,mode) === false) return;
      }
      if (mode === "name" || mode === "insert") rememberDbObject(conn, schema, target);
      onClose();
    } catch(e) { toast(friendlyDbError(e),"error"); } finally {actionLock.current=false;}
  };
  const load = async () => {
    if(actionLock.current) return;actionLock.current=true;setLoading(true);
    try { if (await ensureConnected(scope)) await refreshMeta(scope); } catch(e) { toast(friendlyDbError(e),"error"); } finally { actionLock.current=false;setLoading(false); }
  };
  useEffect(()=>{document.getElementById(`dbx-object-${index}`)?.scrollIntoView?.({block:"nearest"});},[index,query,scope]);
  return <Modal keepMountedWhenInactive open onClose={onClose} ariaLabel="查找数据库对象" className="modal-surface dbx-object-dialog">
    <h2>查找数据库对象</h2>
    <select aria-label="对象查找连接" value={scope} onChange={e => {setScope(e.target.value);setIndex(0);}}>{db.conns.map(c => <option key={c.id} value={c.id}>{c.name} · {ENV_LABEL[c.env]}</option>)}</select>
    <input className="dbx-inp" autoFocus aria-label="查找表名或中文名" role="combobox" aria-expanded aria-controls="dbx-object-options" aria-activedescendant={chosen ? `dbx-object-${Math.min(index,hits.length-1)}` : undefined} placeholder="表名 / 中文名 / 拼音首字母" value={query} onChange={e => {setQuery(e.target.value);setIndex(0);}} onKeyDown={e => {
      if (isImeComposing(e.nativeEvent)) return;
      if (["ArrowDown","ArrowUp","Home","End"].includes(e.key)) {e.preventDefault();setIndex(i => e.key === "Home" ? 0 : e.key === "End" ? hits.length-1 : Math.max(0,Math.min(hits.length-1,i+(e.key === "ArrowDown"?1:-1))));}
      if (e.key === "Enter") {e.preventDefault();void pick(e.shiftKey ? "struct" : e.ctrlKey || e.metaKey ? "name" : "data");}
    }} />
    <p className="dbx-muted">{connOf(scope)?.name} · {rt.tables ? `${names.length} 个已加载对象` : "仅搜索本机缓存，清单可能不完整"} · 显示前 80 项</p>
    <button type="button" className="dbx-btn" disabled={loading || !scope} onClick={() => void load()}>{loading ? "加载中…" : "加载此连接对象"}</button>
    {objectState.loading && <p role="status"><Icon name="spinner" size={12} />读取对象清单；已缓存的表仍可使用…</p>}
    {objectState.error && <div className="dbx-err" role="alert">对象清单读取失败：{objectState.error}<button type="button" className="dbx-btn" onClick={()=>setObjects(v=>({...v,revision:v.revision+1}))}>重新读取</button></div>}
    <div id="dbx-object-options" className="dbx-object-options" role="listbox" aria-label="数据库对象结果">{hits.map((t,i) => <button key={`${t.kind}:${t.name}`} id={`dbx-object-${i}`} role="option" type="button" aria-selected={chosen?.name === t.name && chosen?.kind === t.kind} onClick={() => setIndex(i)} onDoubleClick={() => void pick("data",t)}><strong>{t.name.toLowerCase()}</strong><span>{t.zh}</span><small>{[conn?.name, schema ?? conn?.user, conn && ENV_LABEL[conn.env], t.kind].filter(Boolean).join(" · ")}</small></button>)}</div>
    {!hits.length && !objectState.loading && !objectState.error && <p>没有匹配对象，可加载当前连接或换一个关键词。</p>}
    <div className="dbx-filter-actions"><button type="button" className="dbx-btn pri" disabled={!chosen} aria-keyshortcuts="Enter" onClick={() => void pick("data")}>{chosen && !isTableObject(chosen) ? "查看源码" : "打开数据"}</button><button type="button" className="dbx-btn" disabled={!chosen || !isTableObject(chosen)} aria-keyshortcuts="Shift+Enter" onClick={() => void pick("struct")}>查看结构</button><button type="button" className="dbx-btn" disabled={!chosen || !isTableObject(chosen)} onClick={() => void pick("insert")}>生成查询</button><button type="button" className="dbx-btn" disabled={!chosen || db.activeSqlConn!==scope} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={()=>void pick("name")}>插入当前 SQL</button><button type="button" className="dbx-btn" onClick={onClose}>关闭</button></div>
  </Modal>;
}
const EMPTY_OBJECTS: DbObject[] = [];
