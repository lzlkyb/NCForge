import { useEffect, useState } from "react";
import { invokeOrToast } from "../../lib/tauri";
import { getConfig, patchConfig, type ConfigPatch } from "../../lib/appConfig";
import { toast } from "../ui/toast";
import { APP_INFO, CHANGELOG, CATEGORY_LABELS } from "../../lib/about";
import { Card } from "../ui/card";
import { Modal } from "../ui/Modal";
import { ToggleRow } from "../ui/ToggleRow";
import { SettingsRow } from "../ui/SettingsRow";
import { Button } from "../ui/button";
import { LangSettings } from "../settings/LangSettings";
import { ResourceSettings } from "../settings/ResourceSettings";

/**
 * 示例设置页（壳子版）。演示「读配置 → 表单 → 写配置」闭环，
 * 业务把行项换成自家设置即可。
 *
 * 体量红线同样适用：超 300 行 / 8 个 state 前拆件。
 */
export function SettingsTab({ onChanged }: { onChanged?: () => void }) {
  const [autostart, setAutostart] = useState(false);
  const [releaseOnClose, setReleaseOnClose] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);

  // 挂载拉一次真实配置（get_config 命令，见 commands/system.rs）。
  // 字段名是 snake_case（Rust 没做 rename_all），见 lib/appConfig.ts。
  useEffect(() => {
    void (async () => {
      try {
        const cfg = await getConfig();
        setReleaseOnClose(cfg.release_webview_on_close);
      } catch {
        // 读失败保持默认值即可，不阻断页面
      }
      // 自启开关必须显示**系统真源**（get_autostart 读注册表/LaunchAgent）：
      // 配置里的 autostartEnabled 只是镜像值——用户在系统设置或安装器里改过自启，
      // 镜像不会同步，UI 会显示一个与事实不符的状态。
      const enabled = await invokeOrToast<boolean>("get_autostart", undefined, "读取开机自启状态失败");
      if (typeof enabled === "boolean") setAutostart(enabled);
    })();
  }, []);

  const save = async (patch: ConfigPatch) => {
    // 这里自己管 toast：invokeOrToast 对 Result<> 命令分不清「成功但没返回值」与失败，
    // 只能自己 try/catch。保存失败必须让用户知道——「改了没生效还不响」是最差的失败形态。
    //
    // 只传要改的字段：后端按 patch 局部更新。整份回写会盖掉同一时刻别处（服务页的
    // NC home / 堆上限）的改动，字段名写错还会静默变成一份全默认配置。
    try {
      await patchConfig(patch);
      onChanged?.();
    } catch (e) {
      toast(`保存设置失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <h1 className="text-lg font-medium">设置</h1>

      <Card className="flex flex-col gap-1 p-2">
        <ToggleRow
          label="开机自启"
          sub="登录系统时自动启动（托盘常驻）"
          checked={autostart}
          onChange={async (v) => {
            // 乐观置值 + 失败回滚：set_autostart 返回最终生效状态（Result<bool>），
            // 拿不到布尔值就是失败了——UI 不能显示一个系统里不存在的状态。
            setAutostart(v);
            const finalState = await invokeOrToast<boolean>(
              "set_autostart",
              { enabled: v },
              "设置开机自启失败",
            );
            if (typeof finalState !== "boolean") {
              setAutostart(!v);
              return;
            }
            setAutostart(finalState);
            await save({ autostart_enabled: finalState });
          }}
        />
        <ToggleRow
          label="关窗时释放界面内存"
          sub="关闭窗口时销毁 WebView，省约 80MB 内存"
          checked={releaseOnClose}
          onChange={(v) => {
            setReleaseOnClose(v);
            void save({ release_webview_on_close: v });
          }}
        />
      </Card>

      <LangSettings />

      <ResourceSettings />

      <Card className="flex flex-col gap-1 p-2">
        <SettingsRow
          label="关于"
          sub={`${APP_INFO.name} · ${APP_INFO.license}`}
          control={
            <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
              查看更新历史（{CHANGELOG.length} 版）
            </Button>
          }
        />
        <SettingsRow
          label="版本"
          sub={latestDate()}
          control={<span className="text-sm tabular-nums text-muted-foreground">v{CHANGELOG[0]?.version ?? "0.0.0"}</span>}
        />
        <SettingsRow
          label="仓库"
          sub={APP_INFO.repoUrl}
          control={
            <Button
              variant="ghost"
              size="sm"
              // open_external 有 scheme 白名单（Rust 侧 is_allowed_external_url），
              // 非法 scheme 会 reject——用 invokeOrToast 让失败可见，而不是静默丢弃。
              onClick={() =>
                void invokeOrToast("open_external", { url: APP_INFO.repoUrl }, "打开仓库链接失败")
              }
            >
              打开
            </Button>
          }
        />
      </Card>

      <p className="px-1 text-xs text-muted-foreground">
        分类图例：{Object.values(CATEGORY_LABELS).join(" / ")}
      </p>

      <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} ariaLabel="更新历史" className="modal-surface">
        <div className="flex max-h-[60vh] w-[min(560px,90vw)] flex-col gap-3 overflow-y-auto p-5">
          <h2 className="text-base font-medium">更新历史</h2>
          {CHANGELOG.map((entry) => (
            <div key={entry.version} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium tabular-nums">v{entry.version}</span>
                <span className="text-xs text-muted-foreground">{entry.date}</span>
              </div>
              <ul className="flex flex-col gap-0.5 pl-4">
                {entry.items.map((item, i) => (
                  <li key={i} className="text-xs text-muted-foreground">
                    [{CATEGORY_LABELS[item.category]}] {item.text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {CHANGELOG.length === 0 && <p className="text-sm text-muted-foreground">还没有版本记录。</p>}
        </div>
      </Modal>
    </div>
  );
}

function latestDate(): string {
  return CHANGELOG[0] ? `最近更新：${CHANGELOG[0].date}` : "";
}
