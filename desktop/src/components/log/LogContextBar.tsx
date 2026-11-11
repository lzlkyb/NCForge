import { returnFromLogs, toolReturnLabel, useToolReturn } from "../../lib/toolReturn";
import { Icon } from "../ui/icon";

export function LogContextBar({ searchMode, onMode }: { searchMode: boolean; onMode: (search: boolean) => void }) {
  const flow = useToolReturn();
  return <div className="lg-context">
    <button type="button" className="ux-btn" onClick={returnFromLogs}><Icon name="arrowLeft" size={13} />返回{toolReturnLabel(flow.logs)}</button>
    <div className="ux-segment" role="group" aria-label="日志排查方式">
      <button type="button" aria-pressed={!searchMode} onClick={() => onMode(false)}>问题归因</button>
      <button type="button" aria-pressed={searchMode} onClick={() => onMode(true)}>全文检索</button>
    </div>
    <span className="lg-mode-hint">{searchMode ? "按原文匹配 · 时间与来源有效 · 不受“仅问题”限制" : "按问题规则与慢 SQL 阈值归因 · 可追踪同一 callid"}</span>
  </div>;
}
