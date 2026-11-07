/**
 * 页面表单一真源（P1-15 / 7.7 序 1）。
 *
 * 侧栏、Ctrl+1~N、命令面板、应用菜单、hostedTabs、renderTab、侧栏宽度白名单
 * 全部由 PAGES 派生。新增页面只改这一处。
 *
 * 键位是历史映射（报告 9.7 明确不重排）：Ctrl+1 代码 / 2 版本控制 / 3 数据库 /
 * 4 日志 / 5 设置 / 6 元数据。用 `hotkey` 字段固定，而不是靠数组顺序——
 * 数组顺序服务于侧栏展示，Ctrl 序号由 HOTKEY_TABS 按 hotkey 排序生成。
 *
 * 纪律：本文件只放元数据 + 惰性加载器，不 import 任何组件/Hook（仅 type-only），
 * 避免 App.tsx → pages.ts → 组件 形成循环依赖。component 是动态 import 的
 * 惰性函数，运行时才解析组件模块。
 */
import type { ComponentType } from "react";
import type { IconName } from "../components/ui/icon";

/** 页组件的惰性加载器：形状与 React.lazy 的入参一致。 */
export type PageComponentLoader = () => Promise<{ default: ComponentType<any> }>;

export interface PageDef {
  /** 页面 key（activeTab / ncforge-navigate 的 detail / hostedTabs 用）。 */
  key: string;
  label: string;
  icon: IconName;
  /** 是否挂进外壳的 ActivityPanel（工具页）；false 表示由 WorkbenchShell 自己渲染（文件页）。 */
  hosted: boolean;
  /** 是否在主导航（rail）显示。 */
  showInRail: boolean;
  /** 隐藏项在 rail 的「更多」分组露出（日志排查），不再让看不见的页面占用 Ctrl+4。 */
  railMore?: boolean;
  /** Ctrl+N 的数字；undefined 表示该页没有数字快捷键。 */
  hotkey?: number;
  /** 切到该页时是否默认打开文档面（DOCUMENT_DEFAULT_OPEN / DOCUMENT_TOOLS）。 */
  documentDefault: boolean;
  /** 文档标签由页面自绘（数据库页 ToolTab custom:true）。 */
  documentCustom?: boolean;
  /** 是否参与侧栏宽度记忆（workbenchLayout 的 sides 白名单）。 */
  side: boolean;
  /** 该页工具内容是否停靠进共享侧栏（WorkbenchFrame 的 SIDE_TOOLS）。 */
  sideTool: boolean;
  /** 该页是否把自己的操作条停靠进顶部工具条（WorkbenchFrame 的 TOOLBAR_TOOLS）。 */
  toolbar: boolean;
  /** 页组件惰性加载器；文件页为 null（由 WorkbenchShell 渲染，不进 renderTab）。 */
  component: PageComponentLoader | null;
}

export const PAGES: PageDef[] = [
  {
    key: "files", label: "代码", icon: "code",
    hosted: false, showInRail: true, hotkey: 1,
    documentDefault: false, side: true, sideTool: false, toolbar: false,
    // 文件页带 Monaco，由 WorkbenchShell 自己懒加载，外壳不依赖编辑器。
    component: null,
  },
  {
    key: "svn", label: "版本控制", icon: "gitBranch",
    hosted: true, showInRail: true, hotkey: 2,
    documentDefault: true, side: true, sideTool: true, toolbar: true,
    component: () => import("../components/tabs/SvnTab").then((m) => ({ default: m.SvnTab })),
  },
  {
    key: "db", label: "数据库", icon: "database",
    hosted: true, showInRail: true, hotkey: 3,
    documentDefault: true, documentCustom: true, side: true, sideTool: true, toolbar: false,
    component: () => import("../components/tabs/DbTab").then((m) => ({ default: m.DbTab })),
  },
  {
    key: "logs", label: "日志排查", icon: "log",
    hosted: true, showInRail: false, railMore: true, hotkey: 4,
    documentDefault: true, side: true, sideTool: false, toolbar: false,
    component: () => import("../components/tabs/LogTab").then((m) => ({ default: m.LogTab })),
  },
  {
    key: "meta", label: "元数据", icon: "layers",
    hosted: true, showInRail: true, hotkey: 6,
    documentDefault: true, side: true, sideTool: false, toolbar: false,
    component: () => import("../components/meta/MetaTab").then((m) => ({ default: m.MetaTab })),
  },
  {
    key: "settings", label: "设置", icon: "settings",
    hosted: true, showInRail: false, hotkey: 5,
    documentDefault: true, side: true, sideTool: true, toolbar: false,
    component: () => import("../components/tabs/SettingsTab").then((m) => ({ default: m.SettingsTab })),
  },
];

/** key → 页面定义（renderTab / 事件分支 / 可见性判断用）。 */
export const PAGES_BY_KEY: Record<string, PageDef> = Object.fromEntries(
  PAGES.map((p) => [p.key, p]),
);

/**
 * Ctrl+1~N 的页面 key 序列，按 hotkey 数字升序。
 * 与 PAGES 数组顺序无关，绝不重排（报告 9.7）。
 */
export const HOTKEY_TABS: string[] = PAGES.filter((p) => p.hotkey != null)
  .sort((a, b) => a.hotkey! - b.hotkey!)
  .map((p) => p.key);
