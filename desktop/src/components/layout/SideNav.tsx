import { useLayoutEffect, useState, memo } from "react";
import type { StaticStatus } from "../../lib/types";
import { Icon, type IconName } from "../ui/icon";
import { Collapse } from "../ui/Collapse";
import { APP_INFO } from "../../lib/about";
import { UpdateBadge } from "./UpdateBadge";
import { UpdateCollapsedDot } from "./UpdateCollapsedDot";

export type NavItem = { key: string; label: string; icon: IconName };

/**
 * 壳子示例导航项。业务把这里换成自家页面即可。
 *
 * 🔴 数组顺序即 Ctrl+1~N 的映射顺序 —— App.tsx 直接复用本数组生成快捷键表，
 *    改顺序/增删项只改这一处，避免「侧栏顺序」与「快捷键顺序」两处漂移。
 * 🔴 新项只能追加在末尾：插到中间会把既有 Ctrl+2/3/4 全改一遍，是破坏性变更。
 */
export const WORKSPACE_NAV: NavItem[] = [
  { key: "files", label: "文件", icon: "folder" },
  { key: "search", label: "搜索", icon: "search" },
  { key: "svn", label: "版本控制", icon: "gitBranch" },
  { key: "services", label: "NC 服务", icon: "server" },
  { key: "patch", label: "补丁", icon: "package" },
];

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
  navItems,
  statusPill,
}: {
  activeTab: string;
  onNavigate: (tab: string, anchor?: string) => void;
  /** 更新未读版本数（CHANGELOG 未看过几版），0 不显示红点。 */
  unreadCount: number;
  status?: StaticStatus;
  collapsed: boolean;
  /** 导航项；默认用 WORKSPACE_NAV 示例。 */
  navItems?: NavItem[];
  /** 异常态状态胶囊：null = 不显示（槽位平滑收起）。 */
  statusPill?: { tone: string; text: string; target?: string | null; title: string } | null;
}) {
  const items = navItems ?? WORKSPACE_NAV;

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
      {/* 品牌区：整块可拖窗口（decorations:false，无系统标题栏，必须留出拖拽区域） */}
      <div data-tauri-drag-region className="app-side-head">
        <img
          data-tauri-drag-region
          src="/icon.png"
          alt={APP_INFO.name}
          width={28}
          height={28}
          className="app-side-logo"
          draggable={false}
        />
        <div data-tauri-drag-region className="app-side-brand">
          <span className="app-side-name">{APP_INFO.name}</span>
          <span className="app-side-tagline">{APP_INFO.tagline}</span>
        </div>
      </div>

      <nav className="app-side-nav" aria-label="主导航">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            className="app-side-item"
            data-active={activeTab === item.key || undefined}
            aria-current={activeTab === item.key ? "page" : undefined}
            title={collapsed ? item.label : undefined}
            onClick={() => onNavigate(item.key)}
          >
            <Icon name={item.icon} size={16} className="app-side-icon" />
            <span className="app-side-label">{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="app-side-foot">
        {/* 更新槽位：设置行右端一个**定宽格子**，七种状态在同一个格子里原地变形
            ⇒ foot 高度恒定、导航区零位移。折叠态由 index.css 的 .update-slot 收起。 */}
        <div className="app-side-settings-row">
          <button
            type="button"
            className="app-side-item"
            data-active={activeTab === "settings" || undefined}
            aria-current={activeTab === "settings" ? "page" : undefined}
            title={collapsed ? `设置${unreadCount > 0 ? `（${unreadCount} 项新更新）` : ""}` : undefined}
            onClick={() => onNavigate("settings")}
          >
            <Icon name="settings" size={16} className="app-side-icon" />
            <span className="app-side-label">设置</span>
            {/* changelog-dot：沿用更新未读红点的脉冲动画 + hover 放大。
                无未读时也渲染（--off 缩为零宽），出现/消失都是 scale 过渡。 */}
            <span
              className={`app-side-badge changelog-dot ${unreadCount > 0 ? "" : "app-side-badge--off"}`}
              title={unreadCount > 0 ? `${unreadCount} 项新更新` : undefined}
            >
              {unreadCount > 0 ? unreadLabel : lastUnread > 0 ? (lastUnread > 9 ? "9+" : String(lastUnread)) : ""}
            </span>
          </button>
          {/* 折叠态更新状态点：overlay 按钮，覆盖设置按钮右上角，点状态点=直接执行
              更新动作（一步直达），点齿轮本体仍进设置页。展开态不渲染。 */}
          {collapsed && <UpdateCollapsedDot />}
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
      </div>
    </aside>
  );
}

export const SideNav = memo(SideNavImpl);
