import { useLayoutEffect, useState, memo } from "react";
import type { StaticStatus } from "../../lib/types";
import { railAriaKey, railKeyLabel } from "../../lib/keymap";
import { PAGES, PAGES_BY_KEY } from "../../lib/pages";
import { Icon, type IconName } from "../ui/icon";
import { Collapse } from "../ui/Collapse";
import { UpdateBadge } from "./UpdateBadge";
import { UpdateRailItem } from "./UpdateRailItem";

/**
 * 一项导航。数据源是 lib/pages.ts 的 PAGES（单一真源），本类型只是侧栏渲染所需的投影。
 *
 * `hosted`：这一页是不是「挂在工作台外壳里的工具页」（有 ActivityPanel、可以保活）。
 * `showInRail`：是否在主导航显示；`hotkey`：Ctrl+N 的数字，渲染成按钮上的 <kbd>。
 */
export type NavItem = {
  key: string;
  label: string;
  icon: IconName;
  /** 不设 = true（除了文件页，其余都是工具页）。 */
  hosted?: boolean;
  /** 低频工具保留页面与既有快捷键，只从主导航隐藏。 */
  showInRail?: boolean;
  /** Ctrl+N 的数字（由 PAGES.hotkey 派生，供 <kbd> 显示）。 */
  hotkey?: number;
};

/** 页面 key → 中文名（状态栏等共享位置用），由 PAGES 派生。 */
export const WORKSPACE_LABELS: Record<string, string> = Object.fromEntries(
  PAGES.map((p) => [p.key, p.label]),
);

/**
 * 侧栏主导航项：由 PAGES 派生（P1-15），不再手写第二份页面表。
 * 设置在侧栏 foot 单独渲染（带更新未读红点），不进这里；
 * 隐藏的 logs 由 PAGES.railMore 在「更多」分组露出。
 *
 * 🔴 顺序即侧栏展示顺序；Ctrl+1~N 的映射改为读 PAGES.hotkey（HOTKEY_TABS），
 *    不再由数组顺序推断（历史键位见 lib/pages.ts，报告 9.7 明确不重排）。
 */
export const WORKSPACE_NAV: NavItem[] = PAGES.filter((p) => p.key !== "settings").map((p) => ({
  key: p.key,
  label: p.label,
  icon: p.icon,
  hosted: p.hosted,
  showInRail: p.showInRail,
  hotkey: p.hotkey,
}));

/** rail 按钮上的 Ctrl+N 提示（KBD 风格，内联 utility，不改 CSS）。 */
const KBD = "ml-auto shrink-0 rounded border border-border bg-muted px-1 font-mono text-[10px] leading-4 text-muted-foreground";
/** 设置行右端还有未读红点，kbd 不抢 margin-left:auto，紧跟文字即可。 */
const KBD_INLINE = "shrink-0 rounded border border-border bg-muted px-1 font-mono text-[10px] leading-4 text-muted-foreground";

/**
 * 左侧主导航栏（壳子版）：品牌区（拖拽区）+ 导航项 + 设置入口（带更新未读红点）
 * + 底部状态胶囊 + 更新槽位。
 *
 * 与 cc-bridge 版 SideNav 的差异：剥去了「设置目录模式（SideNavSettings）」
 * 「终端侧栏挂点」等业务件；状态胶囊保留**异常态槽位范式**（Collapse 0fr→1fr），
 * 业务按自家状态机填 tone/text/target 即可。
 */
function SideNavImpl({
  activeTab,
  onNavigate,
  unreadCount,
  status,
  collapsed,
  onToggleRail,
  navItems,
  statusPill,
}: {
  activeTab: string;
  onNavigate: (tab: string) => void;
  /** 更新未读版本数（CHANGELOG 未看过几版），0 不显示红点。 */
  unreadCount: number;
  status?: StaticStatus;
  collapsed: boolean;
  /** 展开 / 收起主导航栏（图标栏 ↔ 带中文页名）。 */
  onToggleRail?: () => void;
  /** 导航项；默认用 WORKSPACE_NAV 示例。 */
  navItems?: NavItem[];
  /** 异常态状态胶囊：null = 不显示（槽位平滑收起）。 */
  statusPill?: { tone: string; text: string; target?: string | null; title: string } | null;
}) {
  const items = (navItems ?? WORKSPACE_NAV).filter((item) => item.showInRail !== false);
  // 隐藏入口（logs）不再让一个看不见的页面独占 Ctrl+4：在「更多」分组露出（P1-16）。
  const moreItems = PAGES.filter((p) => p.railMore);
  const settingsHotkey = PAGES_BY_KEY.settings?.hotkey;

  // 状态口径：startupError 升红；running 但业务报异常 = warn。壳子只演示范式。
  const startupError = status?.startupError ?? null;
  const pillShown = !!startupError || !!statusPill;
  // 拆成原始值做依赖（对齐 cc-bridge 原版模式）：对象每次渲染都是新引用，
  // 直接当依赖会让 useLayoutEffect 每拍重跑并 setState 出新对象 → 无限渲染循环。
  const pillTone = statusPill?.tone;
  const pillText = statusPill?.text;
  const pillTarget = statusPill?.target ?? null;
  const pillTitle = statusPill?.title ?? "";

  const unreadLabel = unreadCount > 9 ? "9+" : String(unreadCount);

  // 未读红点 scale 过渡：不条件渲染——硬插入会把「设置」两个字挤一下。
  // 常驻渲染、0 时缩到 0 宽；退场动画期间保留最后一个非零计数。
  const [lastUnread, setLastUnread] = useState(0);
  useLayoutEffect(() => {
    if (unreadCount > 0) setLastUnread(unreadCount);
  }, [unreadCount]);

  // 状态胶囊槽位化：异常态出现/消失套 Collapse 行槽位（0fr→1fr），
  // foot 高度从「啪地长高一截」变成平滑展开/收起。退场期间保留最后一份异常
  // 快照渲染——收起时若跟着状态变回正常态文案，胶囊会在收缩中闪现。
  const [heldPill, setHeldPill] = useState<{
    tone: string;
    text: string;
    target: string | null;
    title: string;
  } | null>(null);
  useLayoutEffect(() => {
    if (!pillShown) return;
    setHeldPill(startupError
      ? { tone: "bad", text: "启动失败", target: "settings", title: "点击前往设置查看" }
      : { tone: pillTone!, text: pillText!, target: pillTarget, title: pillTitle });
  }, [pillShown, startupError, pillTone, pillText, pillTarget, pillTitle]);

  return (
    <aside className="app-side" data-collapsed={collapsed || undefined}>
      <nav className="app-side-nav" aria-label="主导航">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            className="app-side-item"
            data-active={activeTab === item.key || undefined}
            aria-current={activeTab === item.key ? "page" : undefined}
            aria-label={item.label}
            title={collapsed ? item.label : undefined}
            onClick={() => onNavigate(item.key)}
          >
            <Icon name={item.icon} size={collapsed ? 19 : 16} className="app-side-icon" />
            <span className="app-side-label">{collapsed && item.key === "svn" ? "版本" : collapsed && item.key === "logs" ? "日志" : item.label}</span>
            {!collapsed && item.hotkey != null && <kbd className={KBD}>Ctrl+{item.hotkey}</kbd>}
          </button>
        ))}
      </nav>
      {/* 「更多」分组放在主导航 nav 之外：nav 内保持恰好 4 个常用项（既有测试断言），
          隐藏页在这里露出并带 Ctrl+N，避免一个看不见的页面占用 Ctrl+4（P1-16）。
          aria-label 带上快捷键描述，读屏能念出「日志排查 · Ctrl+4」。 */}
      {moreItems.length > 0 && (
        <div className="mt-1 flex flex-col gap-1 border-t border-border/60 px-2 pt-1">
          {!collapsed && <div className="px-2 py-0.5 text-[11px] font-medium text-muted-foreground">更多</div>}
          {moreItems.map((p) => (
            <button
              key={p.key}
              type="button"
              className="app-side-item"
              data-active={activeTab === p.key || undefined}
              aria-current={activeTab === p.key ? "page" : undefined}
              aria-label={`${p.label} · Ctrl+${p.hotkey}`}
              title={collapsed ? p.label : undefined}
              onClick={() => onNavigate(p.key)}
            >
              <Icon name={p.icon} size={collapsed ? 19 : 16} className="app-side-icon" />
              <span className="app-side-label">{collapsed ? "日志" : p.label}</span>
              {!collapsed && p.hotkey != null && <kbd className={KBD}>Ctrl+{p.hotkey}</kbd>}
            </button>
          ))}
        </div>
      )}

      <div className="app-side-foot">
        {/* 折叠态更新入口：独立一行 rail 项（图标在上、文字在下），与设置同构。
            🔴 只有真有更新时才渲染（空闲态不出占位，手动检查在展开态徽章与设置页）；
            点它只打开详情，不直接下载/安装。展开态由设置行右端的更新槽位承担。 */}
        {collapsed && <UpdateRailItem />}
        {/* 更新槽位：设置行右端一个**定宽格子**，七种状态在同一个格子里原地变形
            ⇒ foot 高度恒定、导航区零位移。折叠态由 index.css 的 .update-slot 收起。 */}
        <div className="app-side-settings-row">
          <button
            type="button"
            className="app-side-item"
            data-active={activeTab === "settings" || undefined}
            aria-current={activeTab === "settings" ? "page" : undefined}
            aria-label={unreadCount > 0 ? `设置，${unreadCount} 项更新记录未读` : "设置"}
            title={collapsed || unreadCount > 0 ? `设置${unreadCount > 0 ? `（${unreadCount} 项更新记录未读）` : ""}` : undefined}
            onClick={() => onNavigate("settings")}
          >
            <Icon name="settings" size={16} className="app-side-icon" />
            <span className="app-side-label">设置</span>
            {!collapsed && settingsHotkey != null && <kbd className={KBD_INLINE}>Ctrl+{settingsHotkey}</kbd>}
            {/* changelog-dot：沿用更新未读红点的脉冲动画 + hover 放大。
                无未读时也渲染（--off 缩为零宽），出现/消失都是 scale 过渡。 */}
            <span
              className={`app-side-badge changelog-dot ${unreadCount > 0 ? "" : "app-side-badge--off"}`}
              title={unreadCount > 0 ? `${unreadCount} 项新更新` : undefined}
            >
              {unreadCount > 0 ? unreadLabel : lastUnread > 0 ? (lastUnread > 9 ? "9+" : String(lastUnread)) : ""}
            </span>
          </button>
          {/* 折叠态更新状态点已改为 foot 里的独立「更新」项（UpdateRailItem）：
              压齿轮角的小圆点与设置自身的 changelog 红点视觉撞车，且折叠态没有文字。 */}
          <UpdateBadge currentVersion={status?.version} />
        </div>

        {/* 服务状态胶囊：异常才现，槽位化平滑展开/收起。 */}
        <Collapse open={pillShown}>
          {heldPill && (
            <button
              type="button"
              className="app-side-status status-pill"
              data-tone={heldPill.tone}
              title={heldPill.title}
              data-clickable={heldPill.target ? true : undefined}
              onClick={() => heldPill.target && onNavigate(heldPill.target)}
            >
              <span className="app-side-status-dot" />
              <span className="app-side-status-text">{heldPill.text}</span>
            </button>
          )}
        </Collapse>
        {onToggleRail && (
          <button
            type="button"
            className="app-side-item app-side-rail-toggle"
            aria-label={collapsed ? "展开导航栏" : "收起导航栏"}
            aria-expanded={!collapsed}
            aria-keyshortcuts={railAriaKey()}
            title={collapsed ? `展开导航栏（${railKeyLabel()}）` : undefined}
            onClick={onToggleRail}
          >
            <Icon name={collapsed ? "chevronRight" : "chevronLeft"} size={16} className="app-side-icon" />
            <span className="app-side-label">{collapsed ? "展开" : "收起导航"}</span>
          </button>
        )}
      </div>
    </aside>
  );
}

export const SideNav = memo(SideNavImpl);
