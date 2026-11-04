import { useCallback, useEffect, useRef, useState } from "react";
import { trackOperation } from "../../lib/operations";
import { useResources } from "../../contexts/ResourceContext";
import { formatBytes, packStateLabel, resourceFriendlyError } from "../../lib/resource";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Badge } from "../ui/badge";
import { SettingsRow } from "../ui/SettingsRow";
import { InlineNotice } from "../ui/notice";
import { Skeleton } from "../ui/Skeleton";
import "./settings-maintenance.css";

/**
 * 「组件」设置卡（方案 B）：三个资源包的本地状态 + 重新下载入口。
 *
 * 与初始化对话框的分工：对话框管首启引导（自动下载），本卡管日常可见性与
 * 手动重下（用户怀疑组件损坏 / 版本变化后主动刷新）。状态全部来自
 * ResourceContext 的本地快照，本组件不发任何网络请求。
 */
export function ResourceSettings() {
  const { packs, phase, ensure, refreshStatus, error, errorCode } = useResources();
  const [redownloading, setRedownloading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const lock = useRef(false);

  const busy = phase === "downloading" || phase === "checking";
  const readStatus = useCallback(async () => {
    setReading(true);
    const list = await trackOperation({ key: "resources.status", label: "读取运行组件状态", page: "settings" }, refreshStatus, list => ({ state: list ? "success" : "failed", detail: list ? undefined : "读取组件状态失败，请重新读取" }));
    setReadError(list ? null : "读取组件状态失败，请重新读取");
    setReading(false);
  }, [refreshStatus]);

  useEffect(() => {
    let cancelled = false;
    // 只读本地快照。读取失败不能让设置页永久停留在“读取中”。
    void refreshStatus().then((list) => {
      if (!cancelled) setReadError(list ? null : "读取组件状态失败，请重新读取");
    });
    return () => { cancelled = true; };
  }, [refreshStatus]);

  const redownload = async () => {
    if (lock.current || busy) return;
    lock.current = true;
    setRedownloading(true);
    try {
      // force=true：无视已有状态（含 legacy 认领）强制重下。
      // 完成后由 resource:ready 事件刷新快照，这里只负责按钮态收尾。
      await ensure(true);
    } finally {
      setRedownloading(false);
      lock.current = false;
      await readStatus();
    }
  };

  return (
    <Card className="settings-maintenance-section">
      <div className="settings-maintenance-heading">
        <h2>运行组件</h2>
        <p>编译与代码智能所需的运行文件，下载后保存在本机。</p>
      </div>
      {packs.map((pack, i) => (
        <SettingsRow
          key={pack.id}
          id={`resource-${pack.id}`}
          label={pack.title}
          keywords={["运行组件", "资源包", "编译", "下载"]}
          valueText={packStateLabel(pack.state)}
          sub={
            <>
              {pack.notes}
              {pack.state === "installed" && pack.version ? ` · v${pack.version}` : ""}
              {pack.size != null ? ` · ${formatBytes(pack.size)}` : ""}
            </>
          }
          last={i === packs.length - 1}
          control={
            <Badge
              variant={pack.state === "missing" ? "destructive" : pack.state === "legacy" ? "secondary" : "success"}
            >
              {packStateLabel(pack.state)}
            </Badge>
          }
        />
      ))}
      {packs.length === 0 && !readError && <div className="settings-resource-loading" role="status" aria-label="正在读取组件状态">
        <Skeleton className="h-4 w-40" /><Skeleton className="h-4 w-52" />
      </div>}
      {readError && <InlineNotice variant="error"><div className="flex flex-col items-start gap-2">
        <span>{readError}</span><Button variant="outline" size="sm" isLoading={reading} loadingText="读取中…" disabled={reading} onClick={() => void readStatus()}>{reading ? "读取中…" : "重新读取"}</Button>
      </div></InlineNotice>}
      <SettingsRow id="resource-redownload" label="重新下载组件" keywords={["强制下载", "组件维护", "修复组件"]}
        sub="组件损坏或需要刷新时，重新下载全部运行组件"
        info="此操作会强制重新下载全部运行组件，需要网络连接。组件更新与软件更新分别管理。"
        valueText={busy || redownloading ? "处理中" : "可重新下载"} last
        control={<Button variant="outline" size="sm" isLoading={busy || redownloading} loadingText={phase === "checking" ? "检查中…" : "下载中…"} disabled={busy || redownloading} onClick={() => void redownload()}>
          {phase === "checking" ? "检查中…" : busy || redownloading ? "下载中…" : "重新下载全部组件"}
        </Button>} />
      {phase === "error" && error && <InlineNotice variant="error">{resourceFriendlyError(error, errorCode).friendly}</InlineNotice>}
    </Card>
  );
}
