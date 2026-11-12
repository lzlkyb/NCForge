import { useCallback, useEffect, useRef, useState } from "react";
import { CodePreview } from "./CodePreview";
import { SqlCodeViewer } from "./SqlCodeViewer";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { friendlyDbError } from "../../lib/db";
import { dbApi, type IndexInfo } from "../../lib/dbApi";
import { trackOperation } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
import { patchTab, type TableTab } from "../../lib/dbStore";
import { ddlKey, dropDdl, readDdl, writeDdl } from "../../lib/ddlCache";
import { copyText } from "../../lib/utils";

/** 索引表与 DDL：切到这页时按需读。对象页（`otype`）走 `get_ddl(类型, 名字)`。 */
export function MetaText({ tab }: { tab: TableTab }) {
  const [selectedIndex,setSelectedIndex]=useState<string|null>(null);
  const [indexDdl,setIndexDdl]=useState<{name:string;text:string}|null>(null);
  const [indexLoading,setIndexLoading]=useState(false);
  const indexRequest=useRef(0);
  const invalidateIndex=useCallback(()=>{indexRequest.current++;},[]);
  useEffect(()=>{invalidateIndex();setSelectedIndex(null);setIndexDdl(null);setIndexLoading(false);return invalidateIndex;},[tab.id,tab.connId,tab.table,invalidateIndex]);
  const readIndex = async(name:string)=>{
    const request=++indexRequest.current;setIndexLoading(true);setIndexDdl(null);
    try {const result=await dbApi.objectDdl(tab.connId,name,"INDEX");if(indexRequest.current === request)setIndexDdl({name,text:result.ddl});}
    catch(error){if(indexRequest.current === request)toast(friendlyDbError(error),"error");}
    finally{if(indexRequest.current === request)setIndexLoading(false);}
  };
  const [request,setRequest]=useState({idx:null as IndexInfo[]|null,ddl:null as string|null,err:null as string|null,revision:0});
  const {idx,ddl,err,revision}=request;
  const key = ddlKey(tab.connId, tab.table, tab.otype, tab.schema);
  useEffect(() => {
    let live=true;setRequest(v=>({...v,err:null,idx:null,ddl:null}));
    const fail = (e: unknown) => {if(live) setRequest(v=>({...v,err:friendlyDbError(e)}));};
    if (tab.sub === "idx") {
      void trackOperation(dbTaskSpec(`indexes:${tab.connId}:${tab.table}`,"读取数据库索引",tab.connId,tab.table,undefined,tab.id),()=>dbApi.indexes(tab.connId, tab.table)).then((r) => {if(live) setRequest(v=>({...v,idx:r.indexes}));}, fail);
      return()=>{live=false;};
    }
    // 命中缓存就直接出，不再往返：一次表 DDL 实测 740ms 起，宽表 1.15s。
    const hit = readDdl(key);
    if (hit !== undefined) { setRequest(v=>({...v,ddl:hit})); return()=>{live=false;}; }
    const req = trackOperation(dbTaskSpec(`ddl:${tab.connId}:${tab.table}`,"读取数据库对象定义",tab.connId,tab.table,undefined,tab.id),()=>tab.otype
      ? dbApi.objectDdl(tab.connId, tab.table, tab.otype)
      : dbApi.ddl(tab.connId, tab.table));
    void req.then((r) => {if(live){writeDdl(key,r.ddl);setRequest(v=>({...v,ddl:r.ddl}));}}, fail);
    return()=>{live=false;};
  }, [key, tab.id,tab.connId, tab.table, tab.sub, tab.otype,revision]);
  const refresh = () => { dropDdl(key); setRequest(v=>({...v,ddl:null,err:null,revision:v.revision+1})); };
  if (err) return <div className="dbx-err">{err}<button type="button" className="dbx-btn" onClick={()=>setRequest(v=>({...v,revision:v.revision+1}))}>重新读取</button></div>;
  if (tab.sub === "ddl") {
    if (ddl === null) return <div className="dbx-empty"><Icon name="spinner" size={18} />读取中…</div>;
    return <SqlCodeViewer key={`${tab.id}:${tab.table}`} text={ddl} connId={tab.connId} label="对象定义" source="DBMS_METADATA.GET_DDL · 已去掉存储参数，复制保留返回原文" onRefresh={refresh} />;
  }
  if (!idx) return <div className="dbx-empty"><Icon name="spinner" size={18} />读取中…</div>;
  return (
    <div className="dbx-meta">
      {selectedIndex && <section className="dbx-index-detail" aria-label="索引详情"><strong>{selectedIndex}</strong><ol>{idx.find(item=>item.name===selectedIndex)?.columns.split(",").map((column,index)=><li key={index}>{column.trim()}</li>)}</ol><button type="button" className="dbx-btn" onClick={()=>void copyText(idx.find(item=>item.name===selectedIndex)?.columns ?? "",()=>toast("已复制索引字段","success"),()=>toast("复制失败","error"))}>复制字段列表</button> <button type="button" className="dbx-btn" onClick={()=>patchTab(tab.id,{sub:"struct"})}>查看表结构</button> <button type="button" className="dbx-btn" disabled={indexLoading} onClick={()=>void readIndex(selectedIndex)}>{indexLoading ? "读取中…" : "查看索引定义"}</button>{indexDdl?.name === selectedIndex && <CodePreview text={indexDdl.text} label="索引定义" connId={tab.connId}/>}</section>}
      <table>
        <thead>
          <tr><th>索引</th><th>字段</th><th>唯一</th><th>状态</th></tr>
        </thead>
        <tbody>
          {idx.map((i) => (
            <tr key={i.name}>
              <td className="mono"><button type="button" className="dbx-lk" aria-expanded={selectedIndex === i.name} onClick={()=>{setSelectedIndex(selectedIndex === i.name ? null : i.name);indexRequest.current++;setIndexLoading(false);setIndexDdl(null);}}>{i.name.toLowerCase()}</button></td>
              <td className="mono">{i.columns.toLowerCase()}</td>
              <td>{i.unique ? "唯一" : ""}</td>
              <td>{i.status}</td>
            </tr>
          ))}
          {idx.length === 0 && <tr><td colSpan={4} className="dbx-muted">没有索引</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
