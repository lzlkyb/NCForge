import { useRef, useState } from "react";
import "../../db-transfer.css";
import { Icon } from "../ui/icon";
import { ContextMenu, type ContextMenuItem } from "../workspace/ContextMenu";
import { freezeTransferFrame, selectionIndices, scopeIndices, type TransferFrame } from "../../lib/resultTransferContext";
import { quickCopyTransfer } from "../../lib/resultTransferQuick";
import { clearTransferJob, transferJobKey, useTransferJob } from "../../lib/resultTransferJobs";
import type { Cell } from "../../lib/dbApi";
import { ResultTransferDialog } from "./ResultTransferDialog";
import type { TransferDialogSeed } from "../../hooks/useResultTransferDialog";
type Mode="copy"|"file";
interface DialogState {frame:TransferFrame;open:boolean;revision:number;seed?:TransferDialogSeed}

export function ResultTransfer({ frame, valueAt }: { frame: TransferFrame; valueAt: (r: number, c: number) => Cell }) {
  const [ui, setUi] = useState<{busy:boolean;menu:{x:number;y:number;items:ContextMenuItem[]}|null;dialogs:Partial<Record<Mode,DialogState>>}>({busy:false,menu:null,dialogs:{}});
  const lock = useRef(false), job = useTransferJob(transferJobKey(frame.source));
  const selected = !!frame.selection, enabled = !!frame.visible.length;
  const activate = (mode:Mode, chosen:DialogState) => {
    const other=mode==="copy" ? "file" : "copy";
    setUi(s=>{const peer=s.dialogs[other];return {...s,menu:null,dialogs:{...s.dialogs,[other]:peer ? {...peer,open:false} : undefined,[mode]:chosen}};});
  };
  const open = (mode:Mode) => {
    const stored=ui.dialogs[mode];
    const recovered=mode==="file" && job?.retry ? {...job.retry,open:true,revision:1} : undefined;
    activate(mode,mode==="file" && job && (stored || recovered) ? {...(stored || recovered)!,open:true} : {frame:freezeTransferFrame(frame,valueAt),open:true,revision:(stored?.revision ?? 0)+1});
  };
  const fileFromCopy = (seed:TransferDialogSeed) => {
    const stored=ui.dialogs.file;
    if(job && ["running","cancelling"].includes(job.state) && stored){activate("file",{...stored,open:true});return;}
    clearTransferJob(transferJobKey(frame.source));
    activate("file",{frame:ui.dialogs.copy?.frame ?? freezeTransferFrame(frame,valueAt),open:true,revision:(stored?.revision ?? 0)+1,seed});
  };
  const quick = async (format: Parameters<typeof quickCopyTransfer>[1]) => { if (lock.current) return; lock.current = true; setUi(s => ({ ...s, busy: true })); try { await quickCopyTransfer(freezeTransferFrame(frame, valueAt), format); } finally { lock.current = false; setUi(s => ({ ...s, busy: false })); } };
  const menu = (x: number, y: number) => setUi(s => ({ ...s, menu: { x, y, items: [
    { label: `${selected ? "选区" : "当前筛选结果"} ${scopeIndices(frame, selected ? "selection" : "filtered").length} 行 × ${selectionIndices(frame).length} 列`, disabled: true, onSelect: () => undefined },
    ...([ ["tsv", "TSV · 贴到 Excel / WPS"], ["csv", "CSV"], ["json", "JSON"], ["markdown", "Markdown 表格"], ["html", "HTML 表格"], ["insert", "SQL · INSERT"], ["where", "SQL · IN 条件（单列）"] ] as const).map(([format, label]) => ({ label, icon: "copy" as const, disabled: !enabled || (format === "where" && selectionIndices(frame).length !== 1), onSelect: () => void quick(format) })),
    { label: "高级复制…", icon: "sliders", separator: true, onSelect: () => open("copy") },
  ] } }));
  return <><div className="dbx-transfer-split"><button type="button" className="dbx-btn ghost" disabled={!enabled || ui.busy} title={selected ? "复制选区；单格复制原始值" : "复制当前筛选结果 · TSV"} aria-label={selected ? "复制选区" : "复制当前结果"} onClick={() => void quick("tsv")}><Icon name={ui.busy ? "spinner" : "copy"} size={14} /><span className="dbx-transfer-action-label">{ui.busy ? "正在生成…" : selected ? "复制选区" : "复制当前结果"}</span></button><button type="button" className="dbx-ibtn" aria-label="复制为" aria-expanded={!!ui.menu} disabled={ui.busy} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); menu(r.left, r.bottom + 4); }}><Icon name="chevronDown" size={12} /></button></div><button type="button" className="dbx-btn ghost" title="选择格式、范围与原生保存位置" aria-label="导出" onClick={() => open("file")}><Icon name="download" size={14} /><span className="dbx-transfer-action-label">导出…</span></button>
    {job && <button type="button" className="dbx-transfer-job-link" aria-label="查看导出任务" onClick={() => open("file")} title={job.summary}><Icon name={["running", "cancelling"].includes(job.state) ? "spinner" : job.state === "success" ? "check" : "alertTriangle"} size={13} /><span>{job.state === "running" ? "正在导出" : job.state === "cancelling" ? "正在停止" : job.state === "partial" ? "部分结果" : job.state === "failed" ? "导出失败" : job.state === "cancelled" ? "已取消" : "已保存"}</span></button>}
    {ui.menu && <ContextMenu {...ui.menu} onClose={() => setUi(s => ({ ...s, menu: null }))} />}
    {(["copy","file"] as const).map(mode=>{const dialog=ui.dialogs[mode];return dialog && <ResultTransferDialog key={`${mode}:${dialog.revision}`} {...dialog} mode={mode} onClose={()=>setUi(s=>({...s,dialogs:{...s.dialogs,[mode]:s.dialogs[mode] ? {...s.dialogs[mode]!,open:false} : undefined}}))} onFile={fileFromCopy} />;})}
  </>;
}
