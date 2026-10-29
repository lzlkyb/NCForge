import { useState } from "react";
import { useResources } from "../../contexts/ResourceContext";
import { formatBytes, packStateLabel } from "../../lib/resource";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Badge } from "../ui/badge";
import { SettingsRow } from "../ui/SettingsRow";
import { Icon } from "../ui/icon";

/**
 * 「组件」设置卡（方案 B）：三个资源包的本地状态 + 重新下载入口。
 *
 * 与初始化对话框的分工：对话框管首启引导（自动下载），本卡管日常可见性与
 * 手动重下（用户怀疑组件损坏 / 版本变化后主动刷新）。状态全部来自
 * ResourceContext 的本地快照，本组件不发任何网络请求。
 */
export function ResourceSettings() {
  const { packs, phase, ensure, refreshStatus } = useResources();
  const [redownloading, setRedownloading] = useState(false);

  const busy = phase === "downloading" || phase === "checking";

  const redownload = async () => {
    setRedownloading(true);
    try {
      // force=true：无视已有状态（含 legacy 认领）强制重下。
      // 完成后由 resource:ready 事件刷新快照，这里只负责按钮态收尾。
      await ensure(true);
    } finally {
      setRedownloading(false);
      await refreshStatus();
    }
  };

  return (
    <Card className="flex flex-col gap-1 p-2">
      <div className="px-2 pt-2">
        <div className="text-sm font-medium">组件</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          编译与代码智能所需的大文件未随安装包分发，按需下载到数据目录，只下一次。
        </div>
      </div>
      {packs.map((pack, i) => (
        <SettingsRow
          key={pack.id}
          label={pack.title}
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
      {packs.length === 0 && (
        <p className="px-2 py-1 text-xs text-muted-foreground">正在读取组件状态…</p>
      )}
      <div className="flex items-center justify-between gap-3 border-t px-2 py-2">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon name="info" size={13} aria-hidden="true" />
          组件损坏或版本变化后，可在这里强制重新下载
        </span>
        <Button variant="outline" size="sm" disabled={busy || redownloading} onClick={() => void redownload()}>
          {busy || redownloading ? "下载中…" : "重新下载组件"}
        </Button>
      </div>
    </Card>
  );
}
