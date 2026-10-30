import { useState, useEffect, useMemo, memo } from "react";
import { getStoredTheme, toggleTheme } from "../../lib/theme";
import { headerSecurityBadges, type SecurityFlags } from "../../lib/headerSecurityBadges";
import { getKeymap, paletteKeyLabel } from "../../lib/keymap";
import { Button } from "../ui/button";
import { APP_INFO } from "../../lib/about";
import { Icon } from "../ui/icon";
import { TitleBarControls } from "./TitleBarControls";
import { SecurityBadgeGroup } from "./SecurityBadgeGroup";
import { UpdateReadout } from "../update/UpdateReadout";

/**
 * 应用标题栏（36px，横跨整个窗口）：品牌 + 安全徽章 + 下载读数 + 主题 + 窗口控件。
 *
 * 与 cc-bridge 版 Header 的差异：剥去了「服务启停按钮」「挂起命令胶囊」等业务件，
 * 保留全部 chrome 范式——拖拽区划分（data-tauri-drag-region）、徽章槽位、
 * UpdateReadout 挂载点、窗口控件。业务按钮加在右侧 group 里即可。
 */
function HeaderImpl({
  flags,
  onNavigate,
  onOpenPalette,
}: {
  /** 安全风险标志（业务自定义，见 lib/headerSecurityBadges）。 */
  flags?: SecurityFlags;
  onNavigate?: (tab: string) => void;
  /** 打开「转到文件 / 类型 / 命令」浮层（App.tsx 接线）。 */
  onOpenPalette?: () => void;
}) {
  const [dark, setDark] = useState(() => getStoredTheme() === "dark");
  // 提示里的快捷键跟随快捷键方案（设置页切换后立即变）
  const [keymap, setKeymapState] = useState(getKeymap);
  useEffect(() => {
    const on = () => setKeymapState(getKeymap());
    window.addEventListener("ncforge-keymap-change", on);
    return () => window.removeEventListener("ncforge-keymap-change", on);
  }, []);

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
      className="app-header app-topbar flex shrink-0 items-center gap-2 border-b pl-3"
    >
      {/* 左侧：品牌（兼作拖拽区）+ 安全徽章（徽章仅在异常态出现，正常时这一区很窄） */}
      <div data-tauri-drag-region className="app-brand">
        <img data-tauri-drag-region src="/icon.png" alt={APP_INFO.name} width={20} height={20} className="app-brand-logo" draggable={false} />
        <span data-tauri-drag-region className="app-brand-name">{APP_INFO.name}</span>
        <SecurityBadgeGroup badges={securityBadges} onNavigate={onNavigate} />
      </div>

      {/* 中部：拖拽空白（无系统标题栏，需要留足可拖区域）+ 下载期读数。
          读数只在这块空白里铺开、且自带 pointer-events:none，拖拽不受影响。 */}
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center self-stretch">
        {onOpenPalette && <button type="button" className="wb-global-search" data-tauri-drag-region="false" onClick={onOpenPalette} title="转到文件、类型、符号或命令（输入 > 进入命令，@ 进入符号）">
          <Icon name="search" size={14} /><span>转到文件、类型、命令…</span><kbd>{paletteKeyLabel("file", keymap)}</kbd>
        </button>}
        <UpdateReadout />
      </div>

      {/* 右侧：搜索 / 主题 / 窗口控件 */}
      <div data-tauri-drag-region="false" className="flex shrink-0 items-center gap-2">
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
