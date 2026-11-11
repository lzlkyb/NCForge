import { useEffect, useState } from "react";
import { SettingsLayout } from "../settings/SettingsLayout";
import { DockRegion } from "../workspace/WorkbenchDock";
import { patchConfig, type ConfigPatch } from "../../lib/appConfig";
import { errorToast } from "../../lib/errorToast";
import { VersionHistoryDialog } from "../settings/VersionHistoryDialog";
import { AutostartRow } from "../settings/AutostartRow";
import { LangSettings } from "../settings/LangSettings";
import { ResourceSettings } from "../settings/ResourceSettings";
import { ConfigTransferSettings } from "../settings/ConfigTransferSettings";
import { KeymapSettings } from "../settings/KeymapSettings";
import { EditorSettings } from "../settings/EditorSettings";
import { SqlFormatSettings } from "../settings/SqlFormatSettings";
import { TaskSettings } from "../settings/TaskSettings";
import { CompileSettings } from "../settings/CompileSettings";
import { NcEnvSettings } from "../settings/NcEnvSettings";
import { AppearanceSettings } from "../settings/AppearanceSettings";
import { UpdateSettings } from "../settings/UpdateSettings";
import { AboutSettings } from "../settings/AboutSettings";
import { consumePendingChangelog, onOpenChangelogRequest } from "../../lib/changelogRequest";

export function SettingsTab({ onChanged }: { onChanged?: () => void }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const openHistory = () => {
    setHistoryOpen(true);
  };
  // 懒加载前收到的更新历史请求仍可打开，保留标题栏与版本徽章的原入口。
  useEffect(() => {
    const open = () => {
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
      errorToast("保存设置", e);
    }
  };

  return <DockRegion region="document"><div className="wb-settings-page">
    <SettingsLayout sections={[
      {
        label: "外观与启动", aliases: ["常规", "外观", "外观与常规"], group: "使用偏好", scope: "本机偏好 · 所有工程",
        description: "调整主题、阅读空间和启动习惯。",
        keywords: ["主题", "材质", "密度", "开机自启", "appearance", "theme"],
        content: <><AppearanceSettings /><div className="settings-section-block"><h2>启动</h2><AutostartRow onSaved={(enabled) => save({ autostart_enabled: enabled })} /></div></>,
      },
      {
        label: "编辑器", group: "使用偏好", scope: "本机偏好 · 所有工程", description: "调整代码排版、编辑辅助与保存方式。输入修改后保存，开关立即应用。",
        keywords: ["字体", "字号", "缩进", "诊断", "代码模板", "editor", "font"], content: <EditorSettings />,
      },
      {
        label: "SQL 格式化", group: "使用偏好", scope: "本机偏好 · 不随配置迁移", description: "通过排版示例选择 SQL 风格，方言可跟随当前连接。",
        keywords: ["SQL", "格式化", "美化", "缩进", "关键字大小写", "方言", "format", "sql-formatter"], content: <SqlFormatSettings />,
      },
      {
        label: "快捷键", group: "使用偏好", scope: "本机偏好 · 所有工程", description: "选择熟悉的方案，或为常用操作修改组合键。",
        keywords: ["键位", "方案", "Eclipse", "IDEA", "冲突", "自定义", "keymap", "shortcut"], content: <KeymapSettings />,
      },
      {
        label: "NC 安装与检测", aliases: ["NC 环境"], group: "NC 开发", scope: "应用配置 · 服务下次启动生效", description: "选择并检测 NC 安装目录，再确认用于编译、服务启动与补丁落位。",
        keywords: ["NC", "home", "安装目录", "中间件", "ncc", "1909", "环境", "探测"], content: <NcEnvSettings />,
      },
      {
        label: "代码智能", aliases: ["开发环境"], group: "NC 开发", scope: "应用配置 · 内存下次启动生效", description: "查看代码补全与跳转的状态，调整自动启动、内存与索引。",
        keywords: ["Java", "JDK", "jdt", "内存", "堆", "轻量模式", "lang", "jvm"], content: <LangSettings />,
      },
      {
        label: "编译与热替换", group: "NC 开发", scope: "应用配置 · 适用于当前打开的工程", description: "管理自动编译、构建性能、热替换与缓存维护。",
        keywords: ["自动编译", "增量", "并行", "缓存", "热替换", "hotswap", "build"], content: <CompileSettings />,
      },
      {
        label: "任务流程", aliases: ["任务"], group: "NC 开发", scope: "自定义任务按工作区保存在本机", description: "按明确的执行顺序组合步骤，保存后从工作台任务菜单运行。",
        keywords: ["编译", "投送", "重启", "补丁", "步骤", "热替换", "task", "build"], content: <TaskSettings />,
      },
      {
        label: "软件与组件", aliases: ["资源与更新", "组件与更新"], group: "维护", scope: "安装与下载保存在本机", description: "管理软件更新，以及编译与代码智能所需的独立组件。",
        keywords: ["下载", "重新下载", "资源", "磁盘", "缓存", "update", "resource"], content: <><UpdateSettings /><ResourceSettings /></>,
      },
      {
        label: "配置迁移", group: "维护", scope: "仅迁移支持的应用配置", description: "导出可迁移配置，导入前核对本机值与路径。",
        keywords: ["导入", "导出", "备份", "JSON", "迁移", "config"], content: <ConfigTransferSettings onChanged={onChanged} />,
      },
      {
        label: "关于与支持", aliases: ["关于"], group: "维护", description: "了解当前运行的软件，查看版本变化与项目支持。",
        keywords: ["版本", "仓库", "许可", "反馈", "license", "about", "changelog"], content: <AboutSettings onOpenHistory={openHistory} />,
      },
    ]} />
    <VersionHistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} />
  </div></DockRegion>;
}
