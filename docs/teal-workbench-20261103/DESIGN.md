---
name: NCForge 深青工作台交互设计稿
description: 以文件、SQL 和日志内容为中心的桌面工作台原型
colors:
  primary: "#24766e"
  primary-dark-theme: "#78bfb4"
  bg: "#f4f5f6"
  surface: "#fff"
  ink: "#29313a"
  selected: "#e8f2ef"
typography:
  body:
    fontFamily: '"Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif'
    fontSize: "13px"
    lineHeight: 1.5
  code:
    fontFamily: '"Cascadia Code",Consolas,"Microsoft YaHei",monospace'
    fontSize: "13px"
    lineHeight: "22px"
rounded:
  control: "6px"
  menu: "10px"
  dialog: "12px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#fff"
    rounded: "{rounded.control}"
    padding: "4px 10px"
---

# Design System: NCForge 深青工作台

## Overview

本文件记录 2026-11-03 交付的独立 HTML 交互设计稿。视觉方向沿用已确认的深青与中性灰，以连续停靠面板呈现代码、数据库、NC 日志与版本控制；高频操作和结果留在当前工作上下文中。

样式事实以 `design/teal-workbench-20261103/style.css` 为准，结构与行为以同目录 `index.html`、`app.js` 为准；本目录的 `PRODUCT.md`、`direction.md` 记录产品边界和方向。`.impeccable/design.json` 补充本次实现的动效、阴影与组件示例，不是应用配置。本交付没有将设计实施到 Tauri / React 生产代码。

打开方式：

- 已启动预览服务时访问 [http://127.0.0.1:8765/](http://127.0.0.1:8765/)。
- 离线直接打开 `D:/AItool/winapp/nc-workbench/design/NCForge-深青工作台-交互设计稿-2026-11-03.html`。
- 模块切换后文件与 SQL 草稿仍在当前页面会话中；刷新或重新打开页面会重置示例业务状态。主题、导航收起、紧凑模式和减少动态效果偏好保存到浏览器本地存储。

## Colors

深青用于主操作、焦点和选中状态；中性表面承载高密度内容，语义色用于状态反馈。下列名称与 CSS 变量一致。

| 变量 | 浅色 | 深色 |
| --- | --- | --- |
| `bg` | `#f4f5f6` | `#181b1f` |
| `surface` | `#fff` | `#202429` |
| `raised` | `#fff` | `#292e34` |
| `hover` | `#eceff1` | `#2c3238` |
| `ink` | `#29313a` | `#e3e7eb` |
| `muted` | `#636d77` | `#a5aeb8` |
| `quiet` | `#77818b` | `#949eaa` |
| `border` | `#dfe3e6` | `#353c43` |
| `primary` | `#24766e` | `#78bfb4` |
| `on-primary` | `#fff` | `#122720` |
| `selected` | `#e8f2ef` | `#293f3a` |
| `selected-ink` | `#21685f` | `#96cdbf` |
| `success` / `success-bg` | `#47754f` / `#edf5ed` | `#a0c396` / `#2b3a2d` |
| `warning` / `warning-bg` | `#966016` / `#fbf3e4` | `#dfb472` / `#3b3224` |
| `danger` / `danger-bg` | `#b44848` / `#fbeded` | `#e49c9c` / `#422c2e` |
| `code-key` | `#785897` | `#c3a7dd` |
| `code-string` | `#8a6134` | `#d4b489` |
| `code-type` | `#226e84` | `#8fbfd3` |
| `code-comment` | `#788277` | `#93a58f` |
| `line` | `#f4f7f6` | `#252e2d` |

## Typography

系统界面字体为 Segoe UI → Microsoft YaHei UI → Microsoft YaHei → sans-serif，默认 `13px / 1.5`。树、工具条、表格与多数按钮为 12px；状态栏、元信息和标签为 11px。设置页标题为 20px/600，日志详情标题为 18px/600，弹窗标题为 16px/600。

编辑器使用 Cascadia Code → Consolas → Microsoft YaHei → monospace，`13px / 22px`，Tab 宽度为 4。控制台与堆栈使用 Consolas，`12px / 1.9`；差异内容为 `12px / 24px`。表格数值列右对齐并使用等宽数字。

## Layout

原型占满 `100dvh`，窗口不整体滚动；树、编辑器、日志和结果区域各自滚动。固定边界与弹性内容区组合，不把桌面工作台缩成卡片。

| 区域 | 实现尺寸 |
| --- | --- |
| 标题栏 / 文档标签栏 / 状态栏 | 36px / 36px / 25px |
| 默认主导航 / 资源侧栏 | 148px / 240px |
| 手动收起主导航 | 64px |
| 默认底部面板 / 树行 | 200px / 30px |
| 紧凑模式底部变量 / 树行变量 | 170px / 26px |
| 横向、纵向分隔拖动区 | 4px |
| 代码面包屑 / 数据库工具条 | 31px / 40px |
| 代码行号区 | 52px |
| 数据结果区默认高度 | 43%，最小 160px |
| 日志列表 / 详情 | `minmax(260px,.44fr)` / `minmax(360px,.56fr)` |
| 弹窗宽度 | `min(560px,calc(100vw - 40px))` |

CSS 在 1100px 及以下将导航/侧栏变量改为 124px/220px，并隐藏部分辅助信息；850px 及以下改为 64px/190px、日志改为单列、差异只展示更新侧；620px 及以下侧栏为 180px，设置与 SVN 纵向排列，工具条换行。拖动分隔条可调整面板，当前会话的显式宽度可能覆盖默认侧栏变量。已检查的桌面视口为 1440×900、1280×800、1024×768；更窄断点存在样式规则，但本次不宣称已完成移动端验收。

## Elevation & Depth

工作台依靠表面色与 1px 边界分区，主要停靠区域保持平面。浮层使用有限阴影：弹窗 `0 18px 60px #0003`、菜单 `0 8px 24px #0002`、提示 `0 4px 18px #0002`；弹窗遮罩为 `#101b244f`。

悬停反馈 100ms；内容切换 170ms 淡入，缓动 `cubic-bezier(.16,1,.3,1)`；弹窗 180ms 淡入并从下方 6px 回位。系统 `prefers-reduced-motion` 或应用减少动态效果开关会关闭动画与过渡。

## Shapes

普通控件圆角 6px、菜单 10px、弹窗 12px；树行、状态标签与快捷键帽为 4px。主停靠面板直角相接。按钮和输入框通常最小高 30px；图标按钮为 28px，SVG 通常 16px、描边 1.65px。焦点使用 2px 深青轮廓；组合搜索框只在外层显示一个焦点框。

## Components

| 区域 | 已实现的原型行为 |
| --- | --- |
| 代码与搜索 | 文件树过滤、标签切换、草稿编辑、保存反馈、未保存关闭提示、工程搜索和命中定位、示例编译输出、底部面板及分隔条 |
| 数据库 | 示例连接与连接表单、SQL 标签、执行/取消、错误反馈、不同表的列结构、结果过滤与 CSV 导出；每个 SQL 标签独立保留结果和事务状态，提供模拟写入、提交与回滚 |
| NC 日志 | 级别/来源/关键词筛选、详情与堆栈、源码或 SQL 跳转、刷新反馈；筛选后详情跟随有效选中项，无结果时清空详情 |
| 版本控制 | 变更选择、差异查看、提交说明校验、模拟提交、下载示例补丁清单 |
| 工作台设置 | 深浅主题、紧凑模式、导航收起、减少动态效果、恢复布局、命令面板与快捷键说明 |

主要快捷键：`Ctrl+1/2/3/4` 切换代码/版本控制/数据库/日志；`Ctrl+Shift+R` 打开转到面板；`Ctrl+K` 或 `Ctrl+H` 工程搜索；`Ctrl+S` 保存会话草稿；`Ctrl+Enter` 执行示例 SQL；`Ctrl+M` 切换编辑器 Tab 为焦点移动，随后可用 Tab 离开编辑器；`Esc` 关闭弹窗。

原型使用本地示例数据和有限 SQL 识别逻辑，没有完整 SQL 引擎，不连接真实数据库、SVN、NC 编译器或服务，不写入工程文件。CSV 与补丁清单是浏览器生成的示例下载；连接测试、编译、提交与服务状态均为模拟反馈。

浏览器检查通过，依据原型目录中的 `verification.json` 与 `fix-verification.json`。前者记录 19 个覆盖类别：草稿保留、搜索跳转、编译反馈、查询结果、标签独立结果、表专属列结构、结果筛选、弹窗 Escape、事务回滚、取消查询、日志筛选、原始搜索包含 INFO、单一焦点框、深浅主题、1280/1024 布局、SVN 校验、命令面板、键盘离开编辑器、减少动态效果。

修正复验的 5 项为：同文件跳转、重复跳转、跨文件搜索跳转、日志筛选后的选择、空日志详情；记录均通过，控制台错误为空。它们验证了同文件定位被旧状态覆盖、筛选后残留日志详情两项修正。

验收截图尺寸：`review-1280.png` 为 **1280×800**，`review-1024-database.png` 为 **1024×768**；`review-code-light.png`、`review-search.png`、`review-database-light.png`、`review-transaction.png`、`review-logs-light.png`、`review-settings-focus.png`、`review-database-dark.png`、`review-code-dark.png`、`review-log-filter-fix.png`、`review-log-empty-fix.png` 均为 **1440×900**。上述截图均位于 `design/teal-workbench-20261103/`。

## Do's and Don'ts

- 保留内容优先、连续面板、就近操作和结果的工作台结构；新增状态沿用现有语义变量。
- 增加控件时同时处理深浅主题、键盘焦点、禁用和减少动态效果。
- 保留示例数据与模拟动作标识，明确页面会话和真实工程的区别。
- 不增加多层卡片、重复工具条或装饰性阴影，不用全窗口缩放替代布局适配。
- 不将浏览器交互检查描述为生产集成验收，不将示例 SQL 反馈描述为数据库执行能力。
