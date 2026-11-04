---
name: NCForge 一体化工作台第二版
description: 统一桌面窗口框架并扩展功能覆盖的独立交互原型
colors:
  primary: "#24766e"
  primary-dark: "#78bfb4"
  chrome: "#eef1f2"
  chrome-dark: "#1b1f23"
  surface: "#ffffff"
  surface-dark: "#202429"
  ink: "#29313a"
  ink-dark: "#e3e7eb"
typography:
  body:
    fontFamily: "Segoe UI, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
    fontSize: "13px"
    lineHeight: 1.5
  code:
    fontFamily: "Cascadia Code, Consolas, Microsoft YaHei, monospace"
    fontSize: "13px"
    lineHeight: "22px"
rounded:
  control: "6px"
  workspace: "8px"
  menu: "10px"
  dialog: "12px"
spacing:
  small: "8px"
  medium: "12px"
  large: "24px"
components:
  window-header:
    height: "40px"
    backgroundColor: "{colors.chrome}"
  compact-navigation:
    width: "60px"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "4px 10px"
---

# Design System: NCForge 一体化工作台

## Overview

用户反馈首版未体现足够的软件功能，并提出壳一体化。第二版沿用深青与中性灰，把标题栏、紧凑导航、文档标签和状态栏统一成同一个窗口框架；功能补充基于现有 `desktop/src/components/` 源码。

在线预览：http://127.0.0.1:8765/ 。离线交付：`design/NCForge-一体化工作台-交互设计稿-v2.html`。首版离线文件保留用于对比。第二版源文件仍在 `design/teal-workbench-20261103/`，由 `app.js`、`db-v2.js`、`integrated.js` 顺序加载，共用原型示例数据。未改生产应用代码。

## Colors

主色沿用浅色 `#24766e`、深色 `#78bfb4`。新增壳表面色：浅色 `#eef1f2`、深色 `#1b1f23`。标题栏、主导航和状态栏同色；内容表面继续使用白色或 `#202429`。选中、错误、警告、成功颜色沿用首版 `style.css` 的语义变量。

正式软件的柔光玻璃模式已独立使用雾白/淡青/蓝灰与石墨灰/深青/冷蓝背景，并共享标题栏、侧栏及设置预览材质；经典模式仍沿用实色。实现和验收边界见 [柔光玻璃材质升级与验收](../../柔光玻璃材质升级与验收-2026-11-03.md)。本 HTML 原型尚未同步该材质升级。

## Typography

系统文字默认 13px，树、工具条与数据表主要使用 12px，辅助信息使用 11px。代码默认 13px/22px，可在编辑器设置中切换字号。编辑器示例使用等宽字体，代码字号可独立于界面文字调整。

## Layout

- 标题栏 40px，包含产品名称、应用菜单、工作区选择、全局搜索、布局与主题、窗口控件。
- 默认主导航 60px；可展开至 148px。文件、数据库、日志、版本控制是主入口；设置在底部。
- 工作区外框仅一层 1px 边界，顶部圆角 8px；侧栏、标签、文档和结果区连续排列。
- 默认资源侧栏 240px，可拖动调整。文档标签栏 36px；代码底部操作栏 36px；状态栏 26px。
- 代码结构/历史等辅助面板按需出现。数据库历史、片段和会话使用右侧抽屉。补丁清单与落位预览并列显示。
- 样式保留 1280/1100/1080/850px 等断点；这些断点的第二版浏览器视觉验收尚未执行，不能引用首版截图作为第二版证明。

## Elevation & Depth

工作台主要靠表面与边界分区。菜单、弹窗和临时抽屉有有限阴影，停靠区域不叠加卡片。沿用 100ms 悬停、170ms 页面淡入、180ms 弹窗动画及减少动态效果开关。

## Shapes

普通控件 6px、菜单 10px、弹窗 12px。窗口控件保持原生位置与矩形点击区域；内容外框顶部 8px。组合输入框使用外层单一焦点，内部输入不叠加轮廓。

## Components

正式软件的设置中心已在 2026-11-03 升级为“工作台 / 开发 / 维护”三组八页，增加具体设置项搜索定位、主题与代码预览、输入校验与真实版本信息。实现和验收边界见 [设置中心升级与验收记录](../../设置中心升级与验收记录-2026-11-03.md)。本节下表仍记录第二版 HTML 原型的功能覆盖，不代表原型已同步本轮设置升级。

| 模块 | 第二版可体验内容 | 对应源码依据 |
| --- | --- | --- |
| 窗口框架 | 工作区选择、应用菜单、布局、主题、最小化与退出反馈、全屏预览 | `layout/Header.tsx`、`TitleBarControls.tsx`、`SideNav.tsx` |
| 文件与检索 | 文件/包视图、新建重命名、编辑保存、搜索替换预览、跳转前后退 | `workspace/FileTree.tsx`、`EditorNavRow.tsx`、`search/` |
| 代码辅助 | 当前文件结构、保存快照/恢复、书签、TODO、示例调用/类型层级 | `OutlinePanel.tsx`、`HistoryPanel.tsx`、`BookmarkPanel.tsx`、`TodoPanel.tsx` |
| 调试与任务 | 附加/暂停/继续/单步、变量与监视、三步任务及取消 | `DebugPanel.tsx`、`DebugWatch.tsx`、`settings/TaskSettings.tsx` |
| NC 服务 | 启停确认、重启、参数、投送预览、日志入口 | `services/`、`workspace/BottomPanel.tsx` |
| 数据库对象 | 表数据、结构、索引、DDL；编辑/新增/删除与待提交、回滚 | `db/TablePage.tsx`、`TableData.tsx`、`TxBar.tsx` |
| 查询工具 | 查询历史、片段、会话锁监控、跨表找值、导入列映射、INSERT 导出、SQL 提取、密码 SQL 演示 | `db/HistoryDrawer.tsx`、`SnippetDrawer.tsx`、`SessionDrawer.tsx`、`ImportDialog.tsx` 等 |
| 数据字典 | 选表、前缀、补丁涉及、字段检索、关联表跳转、复制导出 | `md/DictWorkspace.tsx` |
| 日志 | 沿用来源/时间/文本/慢 SQL 筛选、详情、源码跳转和请求追踪 | `tabs/LogTab.tsx`、`log/` |
| 版本控制 | 工作副本、差异、提交、历史、逐行追溯、冲突/清理示例 | `svn/HistoryView.tsx`、`ConflictPane.tsx`、`BlameView.tsx` |
| 补丁 | 独立工作区、文件选择、变更说明、产物检查、落位与清单导出 | `tabs/PatchWorkspace.tsx`、`patch/` |
| 工程关联 | 依赖链、启停覆盖规则、产物检查 | `linked/LinkedProjectsPanel.tsx` |
| 设置 | 常规、外观、编辑器、快捷键、任务、开发环境、资源与更新、配置迁移、关于 | `tabs/SettingsTab.tsx`、`settings/` |

本稿提供入口、示例数据与代表性交互，没有完整实现正式软件的语言服务、调试器、SQL 引擎、文件系统、SVN 或更新系统。窗口最小化与退出只展示状态；最大化按钮使用浏览器全屏。业务动作不会连接真实系统。导入流程不将数据写回示例网格；密码重置仅生成注释脚本；表元数据是示例。工作区切换使用相同的示例文件，界面会告知这一点。

轻量 DOM 检查记录在 `design/teal-workbench-20261103/v2-dom-verification.json`，涵盖草稿保留、文件操作、结构/历史/书签、调试任务、补丁、字典跳转、表结构与事务、导入映射、查询取消、日志选择及设置等。**用户明确选择先交付，浏览器验收稍后进行；第二版尚无浏览器截图与视觉通过结论。**

## Do's and Don'ts

- 高频操作保持直接可达；高级能力进入对应模块菜单或抽屉，不把所有按钮堆入首屏。
- 新控件继承深浅主题、键盘焦点、禁用状态和减少动态效果。
- 明确区分会话草稿、示例业务反馈和真实执行。
- 不把功能覆盖清单等同于全部生产功能完成，不把 DOM 验证等同于浏览器视觉验收。
- 原型评审后再实施到正式软件；正式窗口须保留拖动区域、系统缩放和原生窗口行为。
