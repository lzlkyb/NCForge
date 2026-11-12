/**
 * 按需求分组时的「cc-bridge 变更日志没开」提示。
 *
 * cc-bridge 的变更日志默认关闭；不开也能用（手工建需求、归入文件），只是 AI 的改动不会自动归类。
 * 所以只提示、可关掉，关掉后本机不再显示同一类提示。
 */
import { useState } from "react";
import { Icon } from "../ui/icon";
import { journalHint } from "../../lib/reqGroups";
import type { ReqView } from "../../lib/requirements";

const KEY = "ncforge.reqJournalHint.dismissed";
const TEXT = {
  off: "没有读到 cc-bridge 的变更日志，AI 改的文件不会自动归到需求。可在 cc-bridge「设置 → 备份与审计 → 变更日志」开启，然后在 AI 客户端执行 /mcp 重连。不开也能手动建需求、归入文件。",
  empty: "cc-bridge 的变更日志里还没有这个工作区的记录。刚开启的话，请在 AI 客户端执行 /mcp 重连后再让它改文件。",
} as const;

function readDismissed(): string[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function ReqJournalHint({ view, loaded }: { view: ReqView; loaded: boolean }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const kind = journalHint(view, loaded);
  if (!kind || dismissed.includes(kind)) return null;
  const dismiss = () => {
    const next = [...dismissed, kind];
    setDismissed(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* 存不下就只在本次会话内隐藏 */ }
  };
  return <div className="vc-alert vc-req-hint" data-tone="info" role="note">
    <Icon name="info" size={14} />
    <span>{TEXT[kind]}</span>
    <button type="button" className="vc-btn vc-btn-sm" aria-label="不再提示" title="不再提示" onClick={dismiss}><Icon name="close" size={12} /></button>
  </div>;
}
