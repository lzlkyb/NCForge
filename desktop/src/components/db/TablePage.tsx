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
import { StructView } from "./StructView";
import { MetaText } from "./MetaText";
import { friendlyDbError, qualifyTable } from "../../lib/db";
import type { ColumnInfo } from "../../lib/dbApi";
import { trackOperation } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
import { columnsOf, patchTab, useConnRt, type TableSub, type TableTab } from "../../lib/dbStore";
import { ask } from "../../lib/dbConfirm";
import { pendingEdits, tableEditKey } from "../../lib/dbDirtyEdits";

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
  const tableRef = qualifyTable(tab.schema, tab.table);
  const currentSchema = rt.currentSchema ?? rt.info?.schema;
  // 表页按打开时的 schema 固化；切默认 schema 后结构 / 索引 / DDL 这些按「当前 schema」
  // 读字典的入口会指向另一份同名对象，所以禁用并说明，避免看起来像同一张表。
  const schemaMismatch = !!tab.schema && !!currentSchema && tab.schema.toUpperCase() !== currentSchema.toUpperCase();
  const isObj = !!tab.otype;
  const isView = !schemaMismatch && rt.tables?.find((t) => t.name === tab.table)?.kind === "VIEW";
  const [cols, setCols] = useState<ColumnInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dlg, setDlg] = useState<"exp" | "imp" | "diff" | "move" | null>(null);

  useEffect(() => {
    setCols(null);
    setErr(null);
    // 对象页不去读字段：包/过程在 user_tab_columns 里根本不存在，读只会白跑一次并报错
    if (isObj || rt.status !== "connected") return;
    let live=true;
    void trackOperation(dbTaskSpec(`columns:${tab.connId}:${tableRef}`,"读取数据库表结构",tab.connId,tableRef,undefined,tab.id),()=>columnsOf(tab.connId, tableRef)).then(r=>{if(live) setCols(r);},e=>{if(live) setErr(friendlyDbError(e));});
    return()=>{live=false;};
  }, [tab.id,tab.connId, tableRef, rt.status, isObj]);

  const zh = Object.fromEntries((cols ?? []).filter((c) => c.zh).map((c) => [c.name.toLowerCase(), c.zh!]));
  const subs = isObj ? OBJ_SUBS : SUBS;
  const returnTo = (step: {tabId:string;label:string}) => {
    if (returnRelated(tab,step)) toast("来源标签已关闭，已重新打开表", "info");
  };
  /** 切子页会卸载数据页，本地未写回的改动随之丢失，所以先问一句。 */
  const switchSub = async (next: TableSub): Promise<boolean> => {
    const count = tab.sub === "data" && next !== tab.sub ? pendingEdits(tableEditKey(tab.id)) : 0;
    if (count > 0) {
      const label = subs.find(s => s.key === next)?.label ?? next;
      const ok = await ask(
        "有未写回的改动",
        `这张表还有 ${count} 处改动没有写回数据库。切到「${label}」后这些改动会丢失；需要保留请先回到数据页点「写回」。`,
        "丢弃并切换",
        true,
      );
      if (!ok) return false;
    }
    patchTab<TableTab>(tab.id, { sub: next });
    return true;
  };

  return (
    <div className="dbx-page">
      <DbContextBar connId={tab.connId} transactionMode={rt.tx ? rt.tx.autoCommit ? "自动提交" : "手动提交" : undefined} />
      {schemaMismatch && (
        <div className="dbx-read-status" role="status">
          此表页属于 {tab.schema}，当前默认 schema 已是 {currentSchema}：数据仍读写 {tab.schema}；结构/索引/DDL 与导入等按当前 schema 取字典或写数据的入口已停用，避免串表。切回 {tab.schema} 或重新打开本表即可恢复。
        </div>
      )}
      {tab.trail?.length ? <nav className="dbx-read-status" aria-label="关联浏览路径">{tab.trail.map((step,i)=><button type="button" className="dbx-lk" key={`${step.tabId}:${i}`} onClick={()=>returnTo(step)}>{step.label} → </button>)}{tab.table}<button type="button" className="dbx-btn" onClick={()=>returnTo(tab.trail![tab.trail!.length-1])}>返回上一表</button></nav>:null}
      <div className="dbx-subtabs" role="tablist" aria-label="数据库对象视图">
        <span className="title">
          <Icon name={isObj ? "file" : isView ? "eye" : "database"} size={14} />
          <span className="dbx-mono" title={tableRef}>{tab.schema ? `${tab.schema.toLowerCase()}.${lower}` : lower}</span>
          <span className="dbx-muted" style={{ fontWeight: 400 }}>{tab.otype ?? rt.ncNames?.[lower]}</span>
        </span>
        {subs.map((s) => (
          <button key={s.key} ref={node => { if (node) tabRefs.current.set(s.key, node); else tabRefs.current.delete(s.key); }} id={`dbx-object-${tab.id}-${s.key}`} aria-controls={panelId} tabIndex={tab.sub === s.key ? 0 : -1} onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const i = subs.findIndex(item => item.key === s.key);
            const next = subs[event.key === "Home" ? 0 : event.key === "End" ? subs.length - 1 : (i + (event.key === "ArrowRight" ? 1 : -1) + subs.length) % subs.length].key;
            void switchSub(next).then((ok) => { if (ok) tabRefs.current.get(next)?.focus(); });
          }} type="button" role="tab" className="t" aria-selected={tab.sub === s.key} data-on={tab.sub === s.key || undefined} onClick={() => void switchSub(s.key)}>
            {s.label}
          </button>
        ))}
        <span className="dbx-sp" />
        {!isObj && (schemaMismatch
          ? <span className="dbx-muted" style={{ fontSize: 11 }}>切回 {tab.schema} 后可导出 / 导入 / 搬运</span>
          : <TableMoreActions
              connId={tab.connId}
              table={lower}
              disabled={rt.status !== "connected"}
              onExport={() => setDlg("exp")}
              onImport={() => setDlg("imp")}
              onStructDiff={() => setDlg("diff")}
              onMove={() => setDlg("move")}
            />)}
      </div>
      {dlg === "exp" && (
        <InsertExportDialog tabId={tab.id}
          connId={tab.connId}
          table={tab.table}
          sql={`select * from ${tableRef.toLowerCase()}`}
          onClose={() => setDlg(null)}
        />
      )}
      {dlg === "imp" && (
        <ImportDialog tabId={tab.id}
          connId={tab.connId}
          table={tableRef}
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
