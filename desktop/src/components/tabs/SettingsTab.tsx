import { useEffect, useState } from "react";
import { SettingsLayout } from "../settings/SettingsLayout";
import { DockRegion } from "../workspace/WorkbenchDock";
import { patchConfig, type ConfigPatch } from "../../lib/appConfig";
import { toast } from "../ui/toast";
import { failureText } from "../../lib/friendlyError";
import { CHANGELOG } from "../../lib/about";
import { markChangelogSeen } from "../../lib/utils";
import { VersionHistoryDialog } from "../settings/VersionHistoryDialog";
import { AutostartRow } from "../settings/AutostartRow";
import { LangSettings } from "../settings/LangSettings";
import { ResourceSettings } from "../settings/ResourceSettings";
import { ConfigTransferSettings } from "../settings/ConfigTransferSettings";
import { KeymapSettings } from "../settings/KeymapSettings";
import { EditorSettings } from "../settings/EditorSettings";
import { TaskSettings } from "../settings/TaskSettings";
import { AppearanceSettings } from "../settings/AppearanceSettings";
import { UpdateSettings } from "../settings/UpdateSettings";
import { AboutSettings } from "../settings/AboutSettings";
import { consumePendingChangelog, onOpenChangelogRequest } from "../../lib/changelogRequest";

export function SettingsTab({ onChanged }: { onChanged?: () => void }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const openHistory = () => {
    markChangelogSeen(CHANGELOG[0]?.version ?? null);
    setHistoryOpen(true);
  };
  // 懒加载前收到的更新历史请求仍可打开，保留标题栏与版本徽章的原入口。
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
    try {
      await patchConfig(patch);
      onChanged?.();
    } catch (e) {
      toast(failureText("保存设置", e), "error");
    }
  };

  return <DockRegion region="document"><div className="wb-settings-page">
    <SettingsLayout sections={[
      {
        label: "外观与常规", aliases: ["常规", "外观"], group: "工作台",
        description: "调整主题、阅读空间和启动习惯。",
        keywords: ["主题", "材质", "密度", "开机自启", "appearance", "theme"],
        content: <><AppearanceSettings /><div className="settings-section-block"><h2>启动</h2><AutostartRow onSaved={(enabled) => save({ autostart_enabled: enabled })} /></div></>,
      },
      {
        label: "编辑器", group: "工作台", description: "调整代码排版、编辑辅助与保存方式。显示偏好保存在本机。",
        keywords: ["字体", "字号", "缩进", "诊断", "代码模板", "editor", "font"], content: <EditorSettings />,
      },
      {
        label: "快捷键", group: "工作台", description: "选择熟悉的方案，或为常用操作修改组合键。",
        keywords: ["键位", "方案", "Eclipse", "IDEA", "冲突", "自定义", "keymap", "shortcut"], content: <KeymapSettings />,
      },
      {
        label: "开发环境", group: "开发", description: "查看代码智能状态，调整资源使用与索引行为。",
        keywords: ["Java", "JDK", "jdt", "内存", "堆", "轻量模式", "lang", "jvm"], content: <LangSettings />,
      },
      {
        label: "任务", group: "开发", description: "查看内置流程，按当前工作区组合自己的开发任务。",
        keywords: ["编译", "投送", "重启", "补丁", "步骤", "task", "build"], content: <TaskSettings />,
      },
      {
        label: "组件与更新", aliases: ["资源与更新"], group: "维护", description: "管理软件更新，查看编译与代码智能所需组件。",
        keywords: ["下载", "重新下载", "资源", "磁盘", "缓存", "update", "resource"], content: <><UpdateSettings /><ResourceSettings /></>,
      },
      {
        label: "配置迁移", group: "维护", description: "导出设置或导入已有配置，导入前可核对内容与路径。",
        keywords: ["导入", "导出", "备份", "JSON", "迁移", "config"], content: <ConfigTransferSettings onChanged={onChanged} />,
      },
      {
        label: "关于", group: "维护", description: "了解当前运行的软件，查看版本变化与项目支持。",
        keywords: ["版本", "仓库", "许可", "反馈", "license", "about", "changelog"], content: <AboutSettings onOpenHistory={openHistory} />,
      },
    ]} />
    <VersionHistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} />
  </div></DockRegion>;
}
