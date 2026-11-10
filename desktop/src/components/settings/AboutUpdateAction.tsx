import type { ReactNode } from "react";
import { useUpdate, friendlyError } from "../../contexts/UpdateContext";
import { formatBytes, formatBytesPerSec } from "../../lib/utils";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

/** Reuse the updater's single operation and confirmation flow; this page only exposes its status. */
export function AboutUpdateAction({ versionKnown, children }: { versionKnown: boolean; children?: ReactNode }) {
  const update = useUpdate();
  const { status, preparing, restarting } = update;
  const busy = preparing || restarting || ["checking", "downloading", "ready", "installing"].includes(status);
  const hasDetails = ["available", "downloading", "ready", "installing", "error"].includes(status);
  const state = preparing ? "正在检查当前工作…" : restarting ? "正在应用更新…" : {
    idle: "新版本可在后台下载，准备好后由你选择重启更新。",
    checking: "正在连接更新源，检查可用版本…",
    available: update.update?.version ? `发现新版本 v${update.update.version}` : "发现可用更新",
    downloading: !update.progressIndeterminate && update.progress >= 100 ? "下载完成，正在验证更新包…" : update.progressIndeterminate ? "正在下载更新包 · 总大小未知" : `正在下载更新包 · ${Math.round(update.progress)}%`,
    ready: "更新包已下载并验证，可查看后安装。",
    installing: "正在安装并重启…",
    error: update.error ? friendlyError(update.error, update.errorCode).friendly : "更新检查未完成，可查看原因与重试。",
    uptodate: "检查完成，当前已是最新版本。",
  }[status];
  return <div className="settings-about-update" id="about-update" data-settings-item="" data-settings-label="软件更新"
    data-settings-keywords="检查更新 升级 下载" data-setting-value={state} tabIndex={-1}>
    <div className="settings-about-actions">
      <Button size="sm" isLoading={status === "checking"} loadingText="检查中…" disabled={busy || !versionKnown}
        title={!versionKnown ? "读取运行版本后可检查更新" : busy ? "当前更新流程尚未完成" : undefined}
        onClick={() => void update.manualCheckForUpdate()}><Icon name="refresh" size={14} />检查更新</Button>
      {hasDetails && <Button variant="outline" size="sm" disabled={preparing || restarting} onClick={update.openUpdateNotes}>
        {status === "downloading" ? "查看下载进度" : status === "ready" ? "查看并安装" : status === "error" ? "查看原因与重试" : "查看更新"}
      </Button>}
      {children}
    </div>
    <p className={`settings-about-status ${status === "error" ? "is-error" : ""}`} role="status">{state}</p>
    {status === "downloading" && <p className="settings-about-download">{formatBytes(update.downloadedBytes)}
      {update.totalBytes ? ` / ${formatBytes(update.totalBytes)}` : ""} · {!update.progressIndeterminate && update.progress >= 100 ? "校验中" : update.bytesPerSec > 0 ? formatBytesPerSec(update.bytesPerSec) : "正在连接…"}</p>}
  </div>;
}
