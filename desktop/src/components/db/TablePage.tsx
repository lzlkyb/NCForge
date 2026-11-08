import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ImportDialog } from "./ImportDialog";
import { StructDiffDialog } from "./StructDiffDialog";
import { TransferRowsDialog } from "./TransferRowsDialog";
import { SourceView } from "./SourceView";
import { TableData } from "./TableData";
import { TableMoreActions } from "./TableMoreActions";
import { InsertExportDialog } from "./InsertExportDialog";
import { friendlyDbError } from "../../lib/db";
import { dbApi, type ColumnInfo, type IndexInfo } from "../../lib/dbApi";
import { trackOperation } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
import { columnsOf, patchTab, useConnRt, type TableSub, type TableTab } from "../../lib/dbStore";
import { copyText } from "../../lib/utils";

import { returnRelated } from "../../lib/dbRelations";
import { DbContextBar } from "./DbContextBar";

const SUBS: { key: TableSub; label: string }[] = [
  { key: "data", label: "数据" },
  { key: "struct", label: "结构" },
  { key: "idx", label: "索引" },
  { key: "ddl", label: "DDL" },
];

/** 对象页（包/过程/序列…）只有两页：源码与 DDL。字段/索引/数据对它没有意义。 */
const OBJ_SUBS: { key: TableSub; label: string }[] = [
  { key: "source", label: "源码" },
  { key: "ddl", label: "DDL" },
];

/** 表页：数据 / 结构（含 NC 中文名）/ 索引 / DDL。对象页（`tab.otype` 有值）只保留源码与 DDL。 */
export function TablePage({ tab }: { tab: TableTab }) {
  const tabRefs = useRef(new Map<TableSub, HTMLButtonElement>());
  const panelId = `dbx-object-${tab.id}-panel`;
  const rt = useConnRt(tab.connId);
  const lower = tab.table.toLowerCase();
  const isObj = !!tab.otype;
  const isView = rt.tables?.find((t) => t.name === tab.table)?.kind === "VIEW";
  const [cols, setCols] = useState<ColumnInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dlg, setDlg] = useState<"exp" | "imp" | "diff" | "move" | null>(null);

  useEffect(() => {
    setCols(null);
    setErr(null);
    // 对象页不去读字段：包/过程在 user_tab_columns 里根本不存在，读只会白跑一次并报错
    if (isObj || rt.status !== "connected") return;
    let live=true;
    void trackOperation(dbTaskSpec(`columns:${tab.connId}:${tab.table}`,"读取数据库表结构",tab.connId,tab.table,undefined,tab.id),()=>columnsOf(tab.connId, tab.table)).then(r=>{if(live) setCols(r);},e=>{if(live) setErr(friendlyDbError(e));});
    return()=>{live=false;};
  }, [tab.id,tab.connId, tab.table, rt.status, isObj]);

  const zh = Object.fromEntries((cols ?? []).filter((c) => c.zh).map((c) => [c.name.toLowerCase(), c.zh!]));
  const subs = isObj ? OBJ_SUBS : SUBS;
  const returnTo = (step: {tabId:string;label:string}) => {
    if (returnRelated(tab,step)) toast("来源标签已关闭，已重新打开表", "info");
  };

  return (
    <div className="dbx-page">
      <DbContextBar connId={tab.connId} transactionMode={rt.tx ? rt.tx.autoCommit ? "自动提交" : "手动提交" : undefined} />
      {tab.trail?.length ? <nav className="dbx-read-status" aria-label="关联浏览路径">{tab.trail.map((step,i)=><button type="button" className="dbx-lk" key={`${step.tabId}:${i}`} onClick={()=>returnTo(step)}>{step.label} → </button>)}{tab.table}<button type="button" className="dbx-btn" onClick={()=>returnTo(tab.trail![tab.trail!.length-1])}>返回上一表</button></nav>:null}
      <div className="dbx-subtabs" role="tablist" aria-label="数据库对象视图">
        <span className="title">
          <Icon name={isObj ? "file" : isView ? "eye" : "database"} size={14} />
          <span className="dbx-mono">{lower}</span>
          <span className="dbx-muted" style={{ fontWeight: 400 }}>{tab.otype ?? rt.ncNames?.[lower]}</span>
        </span>
        {subs.map((s) => (
          <button key={s.key} ref={node => { if (node) tabRefs.current.set(s.key, node); else tabRefs.current.delete(s.key); }} id={`dbx-object-${tab.id}-${s.key}`} aria-controls={panelId} tabIndex={tab.sub === s.key ? 0 : -1} onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const i = subs.findIndex(item => item.key === s.key);
            const next = subs[event.key === "Home" ? 0 : event.key === "End" ? subs.length - 1 : (i + (event.key === "ArrowRight" ? 1 : -1) + subs.length) % subs.length].key;
            patchTab<TableTab>(tab.id, { sub: next }); tabRefs.current.get(next)?.focus();
          }} type="button" role="tab" className="t" aria-selected={tab.sub === s.key} data-on={tab.sub === s.key || undefined} onClick={() => patchTab<TableTab>(tab.id, { sub: s.key })}>
            {s.label}
          </button>
        ))}
        <span className="dbx-sp" />
        {!isObj && (
          <TableMoreActions
            connId={tab.connId}
            table={lower}
            disabled={rt.status !== "connected"}
            onExport={() => setDlg("exp")}
            onImport={() => setDlg("imp")}
            onStructDiff={() => setDlg("diff")}
            onMove={() => setDlg("move")}
          />
        )}
      </div>
      {dlg === "exp" && (
        <InsertExportDialog tabId={tab.id}
          connId={tab.connId}
          table={tab.table}
          sql={`select * from ${lower}`}
          onClose={() => setDlg(null)}
        />
      )}
      {dlg === "imp" && (
        <ImportDialog tabId={tab.id}
          connId={tab.connId}
          table={tab.table}
          cols={cols}
          onClose={() => setDlg(null)}
          onDone={() => toast("已有数据写入；关闭此窗口后点击查询刷新表数据，当前编辑尚未丢弃", "info")}
        />
      )}
      {dlg === "diff" && (
        <StructDiffDialog tabId={tab.id} connId={tab.connId} table={lower} onClose={() => setDlg(null)} />
      )}
      {dlg === "move" && (
        <TransferRowsDialog tabId={tab.id} connId={tab.connId} table={lower} onClose={() => setDlg(null)} />
      )}
      <div id={panelId} role="tabpanel" aria-labelledby={`dbx-object-${tab.id}-${tab.sub}`} style={{ display: "contents" }}>
      {rt.status !== "connected" && <div className="dbx-empty">连接已断开，先在左侧连上</div>}
      {err && <div className="dbx-err">{err}</div>}
      {rt.status === "connected" && !isObj && tab.sub === "data" && (
        <TableData tab={tab} cols={cols} isView={isView} zh={zh} />
      )}
      {rt.status === "connected" && !isObj && tab.sub === "struct" && <StructView cols={cols} />}
      {rt.status === "connected" && isObj && tab.sub === "source" && <SourceView tab={tab} />}
      {rt.status === "connected" && tab.sub === "ddl" && <MetaText key={`ddl:${tab.otype ?? ""}`} tab={tab} />}
      {rt.status === "connected" && !isObj && tab.sub === "idx" && <MetaText key="idx" tab={tab} />}
      </div>
    </div>
  );
}

function StructView({ cols }: { cols: ColumnInfo[] | null }) {
  if (!cols) return <div className="dbx-empty"><Icon name="spinner" size={18} />读取中…</div>;
  return (
    <div className="dbx-meta">
      <table>
        <thead>
          <tr><th>#</th><th>字段</th><th>中文名（NC）</th><th>类型</th><th>可空</th><th>默认值</th><th>注释</th></tr>
        </thead>
        <tbody>
          {cols.map((c, i) => (
            <tr key={c.name}>
              <td className="dbx-muted">{i + 1}</td>
              <td className="mono">{c.pk && <span className="pk" title="主键">PK </span>}{c.name.toLowerCase()}</td>
              <td>{c.zh ?? ""}</td>
              <td className="mono">{c.full}</td>
              <td>{c.nullable ? "是" : ""}</td>
              <td className="mono">{c.default ?? ""}</td>
              <td>{c.comment ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 索引表与 DDL：切到这页时按需读。对象页（`otype`）走 `get_ddl(类型, 名字)`。 */
function MetaText({ tab }: { tab: TableTab }) {
  const [request,setRequest]=useState({idx:null as IndexInfo[]|null,ddl:null as string|null,err:null as string|null,revision:0});
  const {idx,ddl,err,revision}=request;
  useEffect(() => {
    let live=true;setRequest(v=>({...v,err:null,idx:null,ddl:null}));
    const fail = (e: unknown) => {if(live) setRequest(v=>({...v,err:friendlyDbError(e)}));};
    if (tab.sub === "idx") {
      void trackOperation(dbTaskSpec(`indexes:${tab.connId}:${tab.table}`,"读取数据库索引",tab.connId,tab.table,undefined,tab.id),()=>dbApi.indexes(tab.connId, tab.table)).then((r) => {if(live) setRequest(v=>({...v,idx:r.indexes}));}, fail);
      return()=>{live=false;};
    }
    const req = trackOperation(dbTaskSpec(`ddl:${tab.connId}:${tab.table}`,"读取数据库对象定义",tab.connId,tab.table,undefined,tab.id),()=>tab.otype
      ? dbApi.objectDdl(tab.connId, tab.table, tab.otype)
      : dbApi.ddl(tab.connId, tab.table));
    void req.then((r) => {if(live) setRequest(v=>({...v,ddl:r.ddl}));}, fail);
    return()=>{live=false;};
  }, [tab.id,tab.connId, tab.table, tab.sub, tab.otype,revision]);
  if (err) return <div className="dbx-err">{err}<button type="button" className="dbx-btn" onClick={()=>setRequest(v=>({...v,revision:v.revision+1}))}>重新读取</button></div>;
  if (tab.sub === "ddl") {
    if (ddl === null) return <div className="dbx-empty"><Icon name="spinner" size={18} />读取中…</div>;
    return (
      <>
        <div className="dbx-rtool">
          <span className="meta">DBMS_METADATA.GET_DDL（已去掉存储参数）</span>
          <span className="dbx-sp" />
          <button type="button" className="dbx-btn ghost" onClick={() => void copyText(ddl, () => toast("已复制 DDL", "success"), (e) => toast(`复制失败：${e}`, "error"))}>
            <Icon name="copy" size={12} />
            复制
          </button>
        </div>
        <pre className="dbx-ddl">{ddl}</pre>
      </>
    );
  }
  if (!idx) return <div className="dbx-empty"><Icon name="spinner" size={18} />读取中…</div>;
  return (
    <div className="dbx-meta">
      <table>
        <thead>
          <tr><th>索引</th><th>字段</th><th>唯一</th><th>状态</th></tr>
        </thead>
        <tbody>
          {idx.map((i) => (
            <tr key={i.name}>
              <td className="mono">{i.name.toLowerCase()}</td>
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
