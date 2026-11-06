import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { useResultTransferDialog, type TransferDialogSeed } from "../../hooks/useResultTransferDialog";
import { transferScopeLabel, type TransferFrame, type TransferScope } from "../../lib/resultTransferContext";
import { clearTransferJob, stopTransferJob, transferJobKey, useTransferJob } from "../../lib/resultTransferJobs";
import { TransferFormatFields, TransferPresets } from "./TransferFormatFields";
import { TransferPreview } from "./TransferPreview";
import { TransferJobView } from "./TransferJobView";
import { InsertExportDialog } from "./InsertExportDialog";
import { toast } from "../ui/toast";

export function ResultTransferDialog({ frame, mode, open, onClose, onFile, seed }: { frame: TransferFrame; mode: "copy" | "file"; open: boolean; onClose: () => void; onFile: (seed:TransferDialogSeed) => void; seed?:TransferDialogSeed }) {
  const c = useResultTransferDialog(frame, mode, seed), s = c.state;
  // File progress must not lock or repeatedly rerender the independent copy window.
  const key = transferJobKey(frame.source), job = useTransferJob(mode === "file" ? key : "");
  const active = !!job && ["running", "cancelling"].includes(job.state), showingJob = mode === "file" && !!job;
  const close = () => { if (!s.busy) onClose(); };
  const primary = () => { if (showingJob) { if (active) void stopTransferJob(key).catch(e => toast(`停止失败：${String(e)}`, "error")); else clearTransferJob(key); } else void c.run(); };
  return <>
    <Modal open={open && !s.ncOpen} onClose={close} closeOnOverlay={!s.busy} className="modal-surface dbx-transfer-dialog" ariaLabel={mode === "copy" ? "高级复制" : "导出查询结果"}>
      <header className="dbx-transfer-head"><div><h2><Icon name={mode === "copy" ? "copy" : "download"} size={18} />{mode === "copy" ? "高级复制" : "导出查询结果"}</h2><p>{frame.source.source} · {frame.source.table || "查询结果"}</p></div>{!showingJob && <button type="button" className="dbx-btn ghost dbx-transfer-preview-jump" onClick={e=>{const preview=e.currentTarget.closest('[role="dialog"]')?.querySelector<HTMLDivElement>(".dbx-transfer-preview");preview?.scrollIntoView({block:"start"});preview?.focus({preventScroll:true});}}>查看预览</button>}<button type="button" className="dbx-ibtn" disabled={!!s.busy} aria-label="关闭输出窗口" onClick={close}><Icon name="close" size={16} /></button></header>
      <div className="dbx-transfer-scroll">{showingJob ? <TransferJobView job={job} /> : <div className="dbx-transfer-settings"><div className="dbx-transfer-config"><TransferPresets controller={c} />
        <section className="dbx-transfer-group"><h3>数据范围</h3>{(Object.keys(transferScopeLabel) as TransferScope[]).map(scope => {
          const disabled = scope === "selection" ? !frame.selection : scope === "query" ? mode === "copy" || !c.canRequery || ["where", "update"].includes(s.options.format) : false;
          const help = scope === "selection" ? frame.selection ? "使用当前矩形选区与所选列" : "先在结果网格选择数据" : scope === "filtered" ? "保持本地筛选、排序及可见列" : scope === "loaded" ? "忽略本地筛选，导出已经读取的行" : mode === "copy" ? "全部重查请使用文件导出" : !c.canRequery ? "此结果不能安全重查，只能导出已读取数据" : "独立只读会话重新取数，最多 200 万行";
          return <label className="dbx-transfer-choice" key={scope} data-disabled={disabled || undefined}><input type="radio" name="dbx-transfer-scope" checked={s.scope === scope && !s.allSets} disabled={disabled} onChange={() => c.scope(scope)} /><span>{transferScopeLabel[scope]}<small>{help}</small></span></label>;
        })}
        {mode === "file" && s.options.format === "xlsx" && (frame.source.sheets?.length ?? 0) > 1 && <label className="dbx-transfer-choice"><input type="checkbox" checked={s.allSets} onChange={e => c.allSets(e.target.checked)} /><span>全部已加载结果集<small>每个结果集独立工作表，保留各自全部字段</small></span></label>}
        {!frame.source.complete && <p className="dbx-transfer-note">已读取的数据可能是部分结果；此范围不会自动补取未读取的行。</p>}
        {s.scope === "query" && <p className="dbx-transfer-note">重新查询不使用网格本地筛选、排序或未保存修改，也看不到主会话未提交的数据。当前预览仅为样本。</p>}
        </section><TransferFormatFields controller={c} mode={mode} columns={frame.data.columns} />
        {mode === "file" && <section className="dbx-transfer-group"><h3>保存文件</h3><label className="dbx-transfer-field">文件名<input aria-label="输出文件名" value={s.fileName} onChange={e => c.patch({ fileName: e.target.value })} /></label><label className="dbx-transfer-field">保存位置<div className="dbx-transfer-path"><input aria-label="保存位置" readOnly value={s.destination?.path ?? "程序导出目录（默认）"} title={s.destination?.path} /><button type="button" className="dbx-btn" disabled={!!s.busy} onClick={() => void c.pick()}><Icon name={s.busy === "pick" ? "spinner" : "folder"} size={14} />选择位置</button></div></label></section>}
      </div><TransferPreview data={c.data} options={s.options} order={s.columnOrder} onColumns={c.columns} onMove={c.move} query={s.scope === "query"} disabled={s.allSets} /></div>}</div>
      {!showingJob && s.notice && <div className="dbx-transfer-feedback" role="status">{s.notice}</div>}
      {!showingJob && (s.error || c.error) && <div className="dbx-transfer-validation" role="alert">{s.error || c.error}</div>}
      <footer className="dbx-transfer-foot"><div className="dbx-transfer-summary"><strong>{showingJob ? job.state === "partial" ? "部分结果" : job.state === "failed" ? "导出失败" : active ? "导出进行中" : "导出已结束" : c.summary}</strong><small>{showingJob ? job.summary : `${s.edited ? "包含未保存修改" : "查询原始值"} · ${s.options.format.toUpperCase()}`}</small></div><div className="dbx-transfer-foot-actions">{mode === "copy" && s.error && <button type="button" className="dbx-btn" onClick={()=>onFile({options:{...s.options},scope:s.scope,edited:s.edited,columnOrder:[...s.columnOrder]})}>改为文件导出</button>}<button type="button" className="dbx-btn" disabled={!!s.busy} onClick={close}>{active && mode === "file" ? "后台运行" : "关闭"}</button><button type="button" className="dbx-btn pri" onClick={primary} disabled={!!s.busy || (!showingJob && (!!c.error || (mode === "file" && !s.fileName.trim()))) || job?.state === "cancelling" || (active && job?.progress.phase === "finalizing")}><Icon name={s.busy ? "spinner" : active ? "stop" : mode === "copy" ? "copy" : "download"} size={14} />{s.busy === "copy" ? "正在生成…" : showingJob ? job.state === "cancelling" ? "正在停止…" : active ? job.progress.phase === "finalizing" ? "完成文件中" : "停止导出" : job.state === "failed" ? "修改设置并重试" : "再次导出" : mode === "copy" ? "复制" : s.options.nc ? "设置 NC 迁移" : "保存文件"}</button></div></footer>
    </Modal>
    {s.ncOpen && frame.source.connId && <InsertExportDialog connId={frame.source.connId} table={s.options.table} schema={s.options.schema} sql={frame.source.sql} params={frame.source.params} tabId={frame.source.tabId} onClose={() => c.patch({ ncOpen: false })} />}
  </>;
}
