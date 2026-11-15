import { useState } from "react";
import { applyStepFilters, readStepFilters, runToCursor } from "../../lib/debugAdvanced";
import { errorToast } from "../../lib/errorToast";
import type { DebugSnapshot } from "../../lib/debugSession";
import "../../java-runtime.css";

export function DebugAdvancedControls({ snap }: { snap: DebugSnapshot }) {
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState(readStepFilters);
  const [busy, setBusy] = useState(false);
  const apply = async () => { setBusy(true); try { await applyStepFilters(filters); setOpen(false); } catch (error) { errorToast("设置步进过滤", error); } finally { setBusy(false); } };
  return <div>
    <div className="dbg-bar">
      <button type="button" className="dbg-btn" disabled={!snap.paused || busy} onClick={() => void runToCursor()} title="运行至当前编辑器光标处；下次暂停后自动移除临时断点">运行到光标</button>
      <button type="button" className="dbg-btn" disabled={snap.status.state !== "attached" || busy} aria-expanded={open} onClick={() => setOpen(value => !value)}>步进过滤</button>
    </div>
    {open && <div className="dbg-filter-form">
      <label>跳过这些包（逗号或换行分隔，支持 *）<textarea value={filters} onChange={event => setFilters(event.target.value)} rows={2} /></label>
      <div className="wb-panel-note">这些规则用于同一代码智能服务下的所有调试目标，包括服务端、客户端和远程。</div>
      <button type="button" className="dbg-btn" disabled={busy} onClick={() => void apply()}>{busy ? "应用中…" : "应用到全部调试目标"}</button>
      <button type="button" className="dbg-btn" disabled={busy} onClick={() => setOpen(false)}>取消</button>
    </div>}
  </div>;
}
