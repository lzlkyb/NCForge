import { SettingsLayout } from "../settings/SettingsLayout";
import { DockRegion } from "../workspace/WorkbenchDock";
import { useEffect, useState } from "react";
import { invokeOrToast } from "../../lib/tauri";
import { patchConfig, type ConfigPatch } from "../../lib/appConfig";
import { toast } from "../ui/toast";
import { failureText } from "../../lib/friendlyError";
import { APP_INFO, CHANGELOG, CATEGORY_LABELS } from "../../lib/about";
import { markChangelogSeen } from "../../lib/utils";
import { Card } from "../ui/card";
import { Modal } from "../ui/Modal";
import { SettingsRow } from "../ui/SettingsRow";
import { Button } from "../ui/button";
import { AutostartRow } from "../settings/AutostartRow";
import { LangSettings } from "../settings/LangSettings";
import { ResourceSettings } from "../settings/ResourceSettings";
import { ConfigTransferSettings } from "../settings/ConfigTransferSettings";
import { KeymapSettings } from "../settings/KeymapSettings";
import { EditorSettings } from "../settings/EditorSettings";
import { TaskSettings } from "../settings/TaskSettings";
import { AppearanceSettings } from "../settings/AppearanceSettings";
import { consumePendingChangelog, onOpenChangelogRequest } from "../../lib/changelogRequest";

/**
 * 示例设置页（壳子版）。演示「读配置 → 表单 → 写配置」闭环，
 * 业务把行项换成自家设置即可。
 *
 * 体量红线同样适用：超 300 行 / 8 个 state 前拆件。
 */
export function SettingsTab({ onChanged }: { onChanged?: () => void }) {
  const [historyOpen, setHistoryOpen] = useState(false);

  // 升级欢迎条等壳层入口要直接打开更新历史：设置页是懒加载的，挂载前发出的请求先存着。
  useEffect(() => {
    const open = () => {
      markChangelogSeen(CHANGELOG[0]?.version ?? null);
      setHistoryOpen(true);
    };
    const off = onOpenChangelogRequest(open);
    if (consumePendingChangelog()) open();
    return off;
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
      toast(failureText("保存设置", e), "error");
    }
  };

  return (
    <DockRegion region="document"><div className="wb-settings-page">
      <SettingsLayout sections={[{ label: "常规", keywords: ["开机自启", "启动", "登录", "通用", "autostart"], content: <Card className="flex flex-col gap-1 p-2">
        <AutostartRow onSaved={(v) => save({ autostart_enabled: v })} />
      </Card> },
      { label: "外观", keywords: ["材质", "玻璃", "经典", "主题", "深色", "浅色", "明暗", "appearance", "theme", "material"], content: <AppearanceSettings /> },
      { label: "快捷键", keywords: ["键位", "方案", "Eclipse", "IDEA", "冲突", "自定义", "keymap", "shortcut"], content: <KeymapSettings /> },
      { label: "编辑器", keywords: ["字号", "字体", "缩进", "自动换行", "小地图", "粘性滚动", "诊断", "Error Lens", "自动保存", "格式化", "代码模板", "editor", "font"], content: <EditorSettings /> },
      { label: "任务", keywords: ["编译", "投送", "重启", "补丁", "步骤", "task", "build"], content: <TaskSettings /> },
      { label: "开发环境", keywords: ["代码智能", "Java", "JDK", "jdt", "内存", "堆", "轻量模式", "索引", "影子工程", "lang", "jvm"], content: <LangSettings /> },
      { label: "资源与更新", keywords: ["组件", "下载", "重新下载", "资源", "更新", "缓存", "磁盘", "update", "resource"], content: <ResourceSettings /> },
      { label: "配置迁移", keywords: ["导入", "导出", "配置", "备份", "JSON", "迁移", "config"], content: <ConfigTransferSettings onChanged={onChanged} /> },
      { label: "关于", keywords: ["版本", "更新历史", "仓库", "许可", "license", "about", "changelog"], content: <><Card className="flex flex-col gap-1 p-2">
        <SettingsRow
          label="关于"
          sub={`${APP_INFO.name} · ${APP_INFO.license}`}
          control={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                // 打开 = 真的看到了：此刻才写 lastSeen，侧栏红点随之清除
                markChangelogSeen(CHANGELOG[0]?.version ?? null);
                setHistoryOpen(true);
              }}
            >
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
      </p></> }]} />

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
    </div></DockRegion>
  );
}

function latestDate(): string {
  return CHANGELOG[0] ? `最近更新：${CHANGELOG[0].date}` : "";
}
