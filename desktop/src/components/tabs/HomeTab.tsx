import { useMemo } from "react";
import { APP_INFO, CHANGELOG } from "../../lib/about";
import { invokeOrToast } from "../../lib/tauri";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { EmptyState } from "../ui/EmptyState";
import { InlineNotice } from "../ui/notice";
import { SettingsRow } from "../ui/SettingsRow";
import { useUpdate } from "../../contexts/UpdateContext";

/**
 * 示例业务页（壳子唯一的内置页面）。**新应用照这个文件的样子加页。**
 *
 * 演示的范式：
 * - 用 ui/ 基础件搭页面（Card / Button / EmptyState / InlineNotice / SettingsRow）
 * - 更新能力接线：useUpdate() 拿更新状态机，触发检查/安装/重启
 * - 写配置的范式看 `SettingsTab` / `LangSettings`（`patchConfig` 只提交要改的字段）
 * - 体量红线：单文件 ≤300 行、useState+useEffect ≤8（check-component-size.mjs 把关），
 *   超了拆 hooks/useXxx.ts + 子组件，不要往本文件堆
 *
 * 2026-10-31：原来这里有一个「关窗时释放界面内存」开关，随托盘模式一起删了。
 */
export function HomeTab() {
  const update = useUpdate();

  const latest = useMemo(() => CHANGELOG[0], []);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-medium">{APP_INFO.name}</h1>
          <p className="text-sm text-muted-foreground">{APP_INFO.description}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void update.manualCheckForUpdate()}>
          {update.status === "checking" ? "检查中…" : "检查更新"}
        </Button>
      </div>

      {update.status === "available" && (
        <InlineNotice variant="info">
          <span className="flex-1">发现新版本 v{update.update?.version ?? "?"}，点击安装后自动下载并重启。</span>
          <Button size="sm" onClick={() => void update.downloadAndInstall()}>
            下载并安装
          </Button>
        </InlineNotice>
      )}
      {update.status === "ready" && (
        <InlineNotice variant="success">
          <span className="flex-1">更新已下载，等待重启。重启后生效，或稍后手动重启。</span>
          <Button size="sm" onClick={() => void update.restart()}>
            立即重启
          </Button>
        </InlineNotice>
      )}

      <Card className="flex flex-col gap-1 p-2">
        <SettingsRow
          label="当前版本"
          sub={latest ? `最近更新：${latest.date}` : "还没有版本记录"}
          control={<span className="text-sm tabular-nums text-muted-foreground">v{latest?.version ?? "0.0.0"}</span>}
        />
        <SettingsRow
          label="安装目录"
          sub="NSIS 安装位置；dev 下为 target 目录"
          control={
            <Button variant="ghost" size="sm" onClick={() => void invokeOrToast("reveal_install_dir")}>
              打开
            </Button>
          }
        />
      </Card>

      <EmptyState
        icon="package"
        description="把本页替换成你的业务页：侧栏导航改 SideNav.tsx 的 WORKSPACE_NAV，页面表在 App.tsx 的 renderTab。"
      />
    </div>
  );
}
