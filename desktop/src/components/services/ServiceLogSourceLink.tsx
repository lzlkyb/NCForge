import { useState, type ReactNode } from "react";
import { Icon } from "../ui/icon";
import { Modal } from "../ui/Modal";
import { toast } from "../ui/toast";
import { findStackSources, openStackSource, stackLocation } from "../../lib/serviceLogSource";
import type { TypeHit } from "../../lib/typeSearch";
import { workspaceEpoch } from "../../lib/workspaceEpoch";

export function ServiceLogSourceLink({ text, children }: { text: string; children?: ReactNode }) {
  const location = stackLocation(text);
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<{ hits: TypeHit[]; epoch: number } | null>(null);
  if (!location) return null;
  const find = async () => {
    if (busy) return;
    setBusy(true); const epoch = workspaceEpoch();
    try {
      const hits = await findStackSources(location);
      if (epoch !== workspaceEpoch()) return;
      if (hits.length === 1) openStackSource(hits[0], location);
      else if (hits.length > 1) setChoices({ hits, epoch });
      else {
        const { runJump } = await import("../../lib/logActions");
        if (epoch === workspaceEpoch()) await runJump({ kind: "source", class: location.className });
      }
    } catch (error) { toast(`定位源码失败：${String(error)}`, "error"); }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" className="sc-log-source" disabled={busy} onClick={() => void find()} title={`定位 ${location.className} · ${location.file}:${location.line}`}>
      {busy && <Icon name="spinner" size={11} className="animate-spin" />}{children ?? `${location.file}:${location.line}`}
    </button>
    <Modal open={choices !== null} onClose={() => setChoices(null)} ariaLabel="选择堆栈源码" className="modal-surface sc-log-dialog">
      <div className="sc-log-dialog-head"><strong>选择源码位置</strong><button className="sc-log-icon" type="button" aria-label="关闭源码选择" onClick={() => setChoices(null)}><Icon name="close" size={15} /></button></div>
      <p>找到多个同名类型，请选择当前运行使用的模块。</p>
      <div className="sc-log-source-choices">{choices?.hits.map(hit => <button key={hit.file} type="button" onClick={() => {
        setChoices(null);
        if (choices.epoch !== workspaceEpoch()) { toast("工程已切换，请重新定位源码", "info"); return; }
        openStackSource(hit, location);
      }}><strong>{hit.module || hit.name}</strong><span>{hit.file}</span></button>)}</div>
    </Modal>
  </>;
}
