import { useUpdate, friendlyError } from "../../contexts/UpdateContext";
import { useAppInfo } from "../../hooks/useAppInfo";
import { formatBytes, formatBytesPerSec } from "../../lib/utils";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { SettingsRow } from "../ui/SettingsRow";
import { InlineNotice } from "../ui/notice";
import "./settings-maintenance.css";

/** 设置页只是更新状态的另一个入口，下载安装仍由现有弹框统一确认。 */
export function UpdateSettings() {
  const info = useAppInfo();
  const update = useUpdate();
  const { status, preparing, restarting } = update;
  const blocked = preparing || restarting || status === "installing";
  const busy = blocked || status === "checking" || status === "downloading" || status === "ready";
  const pct = Math.min(100, Math.max(0, update.progress));
  const stateText = preparing ? "正在检查当前工作" : restarting ? "正在应用更新" : {
    idle: "可检查更新", checking: "正在检查更新", available: "发现新版本",
    downloading: update.progressIndeterminate ? "正在下载" : pct >= 100 ? "正在校验更新包" : `正在下载 · ${pct}%`,
    ready: "更新包已下载并验证", installing: "正在安装并重启", error: "更新暂未完成", uptodate: "已是最新版本",
  }[status];
  const actionText = status === "ready" ? "查看并安装" : status === "downloading" ? "查看下载进度" : status === "error" ? "查看原因与重试" : status === "installing" ? "查看安装进度" : "查看更新";
  const hasDetails = ["available", "downloading", "ready", "installing", "error"].includes(status);
  return (
    <Card className="settings-maintenance-section" aria-busy={status === "checking" || preparing || undefined}>
      <div className="settings-maintenance-heading">
        <h2>软件更新</h2>
        <p>发现新版本会弹出更新内容；安装并重启前会检查当前工作。</p>
      </div>
      <SettingsRow id="update-version" label="当前运行版本" keywords={["版本号", "version"]}
        valueText={info.data?.version ? `v${info.data.version}` : info.isError ? "读取失败" : "版本读取中"}
        sub="来自当前运行的软件"
        control={info.data?.version ? <span className="settings-version">v{info.data.version}</span> :
          info.isError ? <Button variant="outline" size="sm" onClick={() => void info.refetch()}>重新读取版本</Button> : <span className="settings-maintenance-muted">读取中…</span>} />
      <SettingsRow id="update-status" label="更新状态" keywords={["检查更新", "升级", "下载更新", "安装", "重启"]}
        valueText={stateText}
        sub={update.update?.version ? `新版本 v${update.update.version} · ${stateText}` : stateText}
        last control={<div className="settings-maintenance-actions">
          {hasDetails && <Button size="sm" disabled={preparing} onClick={update.openUpdateNotes}>{actionText}</Button>}
          <Button variant="outline" size="sm" isLoading={status === "checking"} loadingText="检查中…" disabled={busy} onClick={() => void update.manualCheckForUpdate()}>{status === "checking" ? "检查中…" : "检查更新"}</Button>
        </div>} />
      {status === "downloading" && <div className="settings-update-progress">
        <div className="settings-update-track" role="progressbar" aria-label="软件更新下载进度" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={update.progressIndeterminate ? undefined : pct} aria-valuetext={update.progressIndeterminate ? "总大小未知" : undefined}>
          <span className={update.progressIndeterminate ? "is-indeterminate" : undefined}
            style={update.progressIndeterminate ? undefined : { transform: `scaleX(${pct / 100})` }} />
        </div>
        <div className="settings-update-metrics"><span>{formatBytes(update.downloadedBytes)}{update.totalBytes ? ` / ${formatBytes(update.totalBytes)}` : " · 总大小未知"}</span>
          <span>{pct >= 100 && !update.progressIndeterminate ? "校验中" : update.bytesPerSec > 0 ? formatBytesPerSec(update.bytesPerSec) : "正在连接…"}</span></div>
      </div>}
      {update.error && <InlineNotice variant="error">{friendlyError(update.error, update.errorCode).friendly}</InlineNotice>}
      {status === "ready" && <p className="settings-maintenance-footnote">安装由你确认，稍后安装可以继续工作。</p>}
    </Card>
  );
}
