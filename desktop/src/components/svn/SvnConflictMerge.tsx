import { useState } from "react";
import { Icon } from "../ui/icon";
import { acceptSvnConflictBlock, remainingSvnConflictMarkers, type SvnConflictChoice } from "../../lib/svnMergeText";
import type { ConflictSnapshot, SvnMergeDraft } from "../../lib/svnHistory";

export function SvnConflictMerge({ data, initialText, locked, saving, onChange, onSave, onLater }: { data: ConflictSnapshot; initialText: string; locked: boolean; saving: boolean; onChange: (text: string) => void; onSave: (draft: SvnMergeDraft) => void; onLater: () => void }) {
  const [result,setResult] = useState(initialText);
  const [showBase,setShowBase] = useState(false);
  const remaining = remainingSvnConflictMarkers(result);
  const canApply = remaining > 0 && acceptSvnConflictBlock(result,"mine") !== null;
  const edit = (text: string) => { setResult(text); onChange(text); };
  const apply = (choice: SvnConflictChoice) => edit(acceptSvnConflictBlock(result,choice) ?? result);
  const pane = (label: string, value: string | undefined) => <section className="vc-merge-pane"><h3>{label}</h3><pre>{value ?? "没有可用副本"}</pre></section>;
  return <>
    <div className="vc-detail-actions vc-bar"><span className="vc-hint">{remaining ? `剩余 ${remaining} 处冲突` : "合并结果待确认"}</span><span className="vc-sp"/>
      <button type="button" className="vc-btn vc-btn-sm" disabled={locked || !canApply} onClick={() => apply("mine")}>本处采用我的</button>
      <button type="button" className="vc-btn vc-btn-sm" disabled={locked || !canApply} onClick={() => apply("theirs")}>本处采用远端</button>
      <button type="button" className="vc-btn vc-btn-sm" disabled={locked || !canApply} onClick={() => apply("both")}>本处保留双方</button>
      {data.base && <button type="button" className="vc-btn vc-btn-sm" aria-pressed={showBase} onClick={() => setShowBase(value => !value)}>{showBase ? "查看我的内容" : "查看共同基线"}</button>}
    </div>
    <div className="vc-merge-grid">
      {showBase ? pane("共同基线 · r" + data.base?.revision,data.base?.text) : pane("我的内容",data.mine?.text)}
      <section className="vc-merge-pane"><h3><label htmlFor="svn-working-merge">合并结果</label></h3><textarea id="svn-working-merge" spellCheck={false} value={result} disabled={locked} onChange={event => edit(event.target.value)}/></section>
      {pane("服务器内容" + (data.theirs ? " · r" + data.theirs.revision : ""),data.theirs?.text)}
    </div>
    <div className="vc-commit-foot"><button type="button" className="vc-btn" disabled={locked} onClick={onLater}>稍后处理</button><span className="vc-sp"/>
      <span className="vc-hint">{remaining ? "先处理剩余冲突标记" : "保存前备份原文件及冲突副本"}</span>
      <button type="button" className="vc-btn vc-btn-primary" disabled={locked || !!remaining} onClick={() => onSave({text:result,expectedMtimeMs:data.workingMtimeMs!})}><Icon name={saving ? "spinner" : "check"} size={13}/>{saving ? "正在保存合并结果…" : "保存并标为已解决"}</button>
    </div>
  </>;
}
