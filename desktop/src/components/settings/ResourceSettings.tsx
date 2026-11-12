import { useCallback, useEffect, useState } from "react";
import { trackOperation } from "../../lib/operations";
import { useResources } from "../../contexts/ResourceContext";
import { formatBytes, packStateLabel, resourceBusy, resourceFriendlyError, RESOURCE_PHASE_TEXT } from "../../lib/resource";
import { ResourceDownloadReadout } from "../resource/ResourceDownloadReadout";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Badge } from "../ui/badge";
import { SettingsRow } from "../ui/SettingsRow";
import { SettingsGroup } from "./SettingsGroup";
import { InlineNotice } from "../ui/notice";
import { Skeleton } from "../ui/Skeleton";
import "./settings-maintenance.css";

export function ResourceSettings() {
  const resources = useResources();
  const { packs, phase, ensure, retry, showDownloads, refreshStatus, error, errorCode, currentId, requestedIds = [], lastInstalled = [] } = resources;
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const busy = resourceBusy(phase);
  const missingIds = packs.filter(p => p.state === "missing").map(p => p.id);
  const readStatus = useCallback(async () => {
    setReading(true);
    try {
      const list = await trackOperation({ key: "resources.status", label: "读取运行组件状态", page: "settings" }, refreshStatus,
        list => ({ state: list ? "success" : "failed", detail: list ? undefined : "读取组件状态失败，请重新读取" }));
      setReadError(list ? null : "读取组件状态失败，请重新读取");
    } finally { setReading(false); }
  }, [refreshStatus]);
  useEffect(() => {
    let cancelled = false;
    void refreshStatus().then(list => { if (!cancelled) setReadError(list ? null : "读取组件状态失败，请重新读取"); });
    return () => { cancelled = true; };
  }, [refreshStatus]);

  return <Card className="settings-maintenance-section">
    <div className="settings-maintenance-heading"><h2>运行组件</h2><p>各组件可独立下载，只在使用对应功能时需要；下载后保存在本机。</p></div>
    {packs.map((pack, i) => {
      const pending = busy && requestedIds.includes(pack.id) && !lastInstalled.some(p => p.id === pack.id);
      const active = pending && pack.id === currentId;
      const failed = phase === "error" && requestedIds.includes(pack.id) && !lastInstalled.some(p => p.id === pack.id);
      const unfinished = ["error", "ready"].includes(phase) && requestedIds.includes(pack.id) && !lastInstalled.some(p => p.id === pack.id);
      const label = active ? RESOURCE_PHASE_TEXT[phase] : pending ? "等待下载" : failed ? "下载失败" : unfinished ? "未完成" : packStateLabel(pack.state);
      return <SettingsRow key={pack.id} id={`resource-${pack.id}`} label={pack.title}
        keywords={["运行组件", "资源包", "编译", "下载", "版本控制", "反编译"]} valueText={label}
        sub={<>{pack.notes}{pack.state === "installed" && pack.version ? ` · v${pack.version}` : ""}{pack.size != null ? ` · ${formatBytes(pack.size)}` : ""}</>}
        last={i === packs.length - 1} control={<div className="flex items-center gap-2">
          <Badge variant={failed || pack.state === "missing" ? "destructive" : pack.state === "legacy" ? "secondary" : "success"}>{label}</Badge>
          <Button variant={pack.state === "missing" ? "default" : "outline"} size="sm" disabled={busy}
            aria-label={`${unfinished ? "重试下载" : pack.state === "missing" ? "下载" : "重新下载"}${pack.title}`}
            isLoading={active} loadingText={RESOURCE_PHASE_TEXT[phase]}
            onClick={() => void (unfinished ? retry([pack.id]) : ensure(pack.state !== "missing", [pack.id]))}>{unfinished ? "重试" : pack.state === "missing" ? "下载" : "重新下载"}</Button>
        </div>} />;
    })}
    {packs.length === 0 && !readError && <div className="settings-resource-loading" role="status" aria-label="正在读取组件状态"><Skeleton className="h-4 w-40" /><Skeleton className="h-4 w-52" /></div>}
    {readError && <InlineNotice variant="error"><div className="flex flex-col items-start gap-2"><span>{readError}</span>
      <Button variant="outline" size="sm" isLoading={reading} loadingText="读取中…" disabled={reading} onClick={() => void readStatus()}>重新读取</Button>
    </div></InlineNotice>}
    <ResourceDownloadReadout {...resources} title={packs.find(p => p.id === currentId)?.title} />
    {busy && <Button variant="link" size="sm" onClick={showDownloads}>查看下载详情</Button>}
    {!busy && missingIds.length > 0 && <SettingsRow id="resource-download-missing" label="下载缺失组件" keywords={["按需下载", "批量下载"]}
      sub={`还有 ${missingIds.length} 个组件未下载，也可在上方分别下载。`} last
      control={<Button size="sm" onClick={() => void ensure(false, missingIds)}>下载缺失组件（{missingIds.length}）</Button>} />}
    <SettingsGroup title="组件维护" summary="需要修复时重新下载">
    <SettingsRow id="resource-redownload" label="重新下载全部组件" keywords={["强制下载", "组件维护", "修复组件"]}
      sub="组件损坏时可单独重下；此维护操作会重新下载全部组件。"
      info="需要网络连接，会重新下载全部运行组件。组件下载与软件更新分别管理。"
      valueText={busy ? "处理中" : "可重新下载"} last
      control={<Button variant="outline" size="sm" disabled={busy} onClick={() => void ensure(true)}>重新下载全部组件</Button>} />
    </SettingsGroup>
    {phase === "error" && error && <InlineNotice variant="error"><div className="flex flex-col items-start gap-2">
      <span>{resourceFriendlyError(error, errorCode).friendly}</span>
      {requestedIds.some(id => !lastInstalled.some(p => p.id === id)) && <Button variant="outline" size="sm" onClick={() => void retry()}>重试剩余组件</Button>}
    </div></InlineNotice>}
  </Card>;
}
