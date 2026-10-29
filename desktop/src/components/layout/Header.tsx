import { useState, useEffect, useMemo, memo } from "react";
import { getStoredTheme, toggleTheme } from "../../lib/theme";
import { headerSecurityBadges, type SecurityFlags } from "../../lib/headerSecurityBadges";
import { shortcutLabel } from "../../lib/platform";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { TitleBarControls } from "./TitleBarControls";
import { SecurityBadgeGroup } from "./SecurityBadgeGroup";
import { UpdateReadout } from "../update/UpdateReadout";

/**
 * 应用顶栏（壳子版）：侧栏开关 + 安全徽章 + 下载读数 + 主题 + 窗口控件。
 *
 * 与 cc-bridge 版 Header 的差异：剥去了「服务启停按钮」「挂起命令胶囊」等业务件，
 * 保留全部 chrome 范式——拖拽区划分（data-tauri-drag-region）、徽章槽位、
 * UpdateReadout 挂载点、窗口控件。业务按钮加在右侧 group 里即可。
 */
function HeaderImpl({
  flags,
  onNavigate,
  onOpenSearch,
  collapsed,
  onToggleCollapse,
  platform,
}: {
  /** 安全风险标志（业务自定义，见 lib/headerSecurityBadges）。 */
  flags?: SecurityFlags;
  onNavigate?: (tab: string) => void;
  /** 跳到搜索页：给 Ctrl+K 一个可见入口（App.tsx 接线）。 */
  onOpenSearch?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** 后端平台串（`std::env::consts::OS`），用于快捷键标签 mac/Windows 分叉。 */
  platform?: string;
}) {
  const [dark, setDark] = useState(() => getStoredTheme() === "dark");

  // 主题由 lib/theme 统一管理，这里只同步图标状态
  useEffect(() => {
    const onTheme = (e: Event) =>
      setDark((e as CustomEvent<"dark" | "light">).detail === "dark");
    window.addEventListener("themechange", onTheme);
    return () => window.removeEventListener("themechange", onTheme);
  }, []);

  const securityBadges = useMemo(() => headerSecurityBadges(flags), [flags]);

  return (
    <header
      data-tauri-drag-region
      className="app-header app-topbar flex shrink-0 items-center gap-2 border-b px-3"
    >
      {/* 左侧：侧栏开关 + 安全徽章（徽章仅在异常态出现，正常时这一区很窄） */}
      <div data-tauri-drag-region="false" className="flex shrink-0 items-center gap-1.5">
        {onToggleCollapse && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleCollapse}
            title={collapsed ? "展开工作区导航" : "收起工作区导航"}
            aria-label={collapsed ? "展开工作区导航" : "收起工作区导航"}
            aria-expanded={!collapsed}
          >
            <Icon name="chevronLeft" size={22} strokeWidth={2.25} className={collapsed ? "rotate-180" : ""} />
          </Button>
        )}
        <SecurityBadgeGroup badges={securityBadges} onNavigate={onNavigate} />
      </div>

      {/* 中部：拖拽空白（无系统标题栏，需要留足可拖区域）+ 下载期读数。
          读数只在这块空白里铺开、且自带 pointer-events:none，拖拽不受影响。 */}
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center self-stretch">
        <UpdateReadout />
      </div>

      {/* 右侧：搜索 / 主题 / 窗口控件 */}
      <div data-tauri-drag-region="false" className="flex shrink-0 items-center gap-2">
        {onOpenSearch && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenSearch}
            title={`搜索页面与设置（${shortcutLabel(platform, "K")}）`}
            aria-label={`搜索（${shortcutLabel(platform, "K")}）`}
            className="gap-1.5 text-muted-foreground"
          >
            <Icon name="search" size={18} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => toggleTheme()}
          title={dark ? "切换浅色主题" : "切换深色主题"}
          aria-label={dark ? "切换浅色" : "切换深色"}
        >
          <Icon name={dark ? "sun" : "moon"} size={18} />
        </Button>

        <TitleBarControls />
      </div>
    </header>
  );
}

export const Header = memo(HeaderImpl);
