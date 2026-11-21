import { useEffect, useState } from "react";
import { useUpdate } from "../../contexts/UpdateContext";
import { formatBytes } from "../../lib/utils";
import { useAppHidden } from "../../lib/appVisibility";
import { useViewActive } from "../../lib/viewActivity";
import { OperationEtaByKey } from "../ui/OperationEta";

/** A single deadline drops the active wording when the download stops advancing. */
const STALL_MS = 4_000;
export function UpdateReadout() {
  const { status, progress, progressIndeterminate, downloadedBytes, totalBytes } = useUpdate();
  const active = status === "downloading";
  const hidden = useAppHidden();
  const shown = useViewActive();
  const verifying = !progressIndeterminate && !!totalBytes && downloadedBytes >= totalBytes;
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!active || hidden || !shown || verifying) return;
    setStalled(false);
    const timer = window.setTimeout(() => setStalled(true), STALL_MS);
    return () => window.clearTimeout(timer);
  }, [active, hidden, shown, verifying, downloadedBytes]);

  const count = totalBytes ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}` : `已下载 ${formatBytes(downloadedBytes)} · 总大小未知`;
  return <div className="settings-update-metrics" hidden={!active} aria-hidden={!active}>
    <span role="progressbar" aria-label="软件更新下载进度" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={active && !progressIndeterminate ? Math.min(100, Math.max(0, progress)) : undefined}
      aria-valuetext={progressIndeterminate ? "总大小未知" : undefined}>{count}</span>
    {verifying ? <span role="status">正在校验</span> : stalled ? <span role="status">等待响应…</span> :
      <OperationEtaByKey taskKey="update.download"/>}
  </div>;
}
