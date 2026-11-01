# NCForge 对标 IntelliJ IDEA：能力缺口清单

> 日期：2026-11-01　作者：阿岩
> 口径：**只记代码里能指到行的现状**。`docs/` 与 `CLAUDE.md` 里有几处过期描述，
> 本文每条都重新 grep 过（例：D4 未编译归因其实已落地、工程关联前端其实已做完）。
>
> 状态标记：**有**（能用）/ **部分**（有但受限）/ **缺**（没有）/ **待验证**（代码矛盾，需实测）
>
> **2026-11-01 晚更新**：本文的 P0 七项、P1 中除 file watcher 外的六项、以及 §2 H 里
> 标"缺"的编辑器体验（字号/字体/换行/缩进、标签拖拽、粘性滚动、自动保存、上次编辑位置、
> 跳转到测试）已全部落地。本文保留原始判定作为历史，**每条后面补了「现已」**；
> 落地清单与证据见 §7。P2（调试器 / 重构 / 终端 / 类型层级 / 语义高亮）按原结论未动。

---

## 0. 结论摘要

NCForge 的强项不在"编辑体验"，而在**NC 特有链路**：类路径真源、多工程依赖闭包、
补丁打包、NC 服务启停、Oracle 直连。这些 IDEA 要么没有、要么要装一堆插件。

对标 IDEA 后，缺口集中在四类：

1. **代码生成与模板**（IDEA 的 Alt+Insert / Live Templates）——原为**全缺**，且 `snippetSupport:false`
   是显式关掉的（`src-tauri/src/lsp.rs:303`），连 `sout` / `fori` 都没有。**现已落地**（见 §7）。
2. **结构浏览与树联动**（包里类视图、右侧类定位左侧树、调用/类型层级）——原为**缺**。
   除类型层级（服务端不支持）外**现已落地**。
3. **调试与运行**（断点、单步、变量、attach 到 NC 的 JVM、单类运行、单测运行）——**仍全缺**（P2，最大空白也最高成本）。
4. **重构**（提取方法/变量、内联、移动、改签名）——只有重命名与安全删除，其余**全缺**；
   jdt.ls 不提供重构 API，自己实现成本高。

已具备且做得不错（不必重做）：跨文件重命名（带预览）、本地历史、全工程搜索替换、
问题面板、SVN 全套、数据库工具窗、多工程依赖链、编码/换行无损处理。

**一个决定成本的关键事实**：内置 jdt.ls 是 **0.57.0**（`scripts/fetch-jdtls.mjs:45`）。
本机 jar 里核实过它已有 `CallHierarchy`（含 `prepareCallHierarchy`）/ `FoldingRange` /
`DocumentHighlight` / `SelectionRange` / `CodeLens`——**这几个"缺"的只是前端接线**；
语义高亮也有，但走的是当年的 draft 协议（要自己翻译，见 §2 D）。
**没有** `TypeHierarchy` / `InlayHint`，这两个要靠升级 jdt.ls 或自己算，别按新版文档规划。

---

## 1. 已具备（防止把已有功能当缺口）

| 域 | 能力 | 证据 |
|---|---|---|
| 语言 | 补全 / 悬停 / 参数提示 / 跳定义 | `lib/langProviders.ts:205,255,269,298` |
| 语言 | 找引用 / 格式化 / 快速修复 / 跳实现 / 跳声明类型 | `lib/langProvidersExtra.ts:88,104,119,154,163` |
| 语言 | 重命名（自研，跨文件 + 先预览，未打开的按原编码写回） | `lib/renameSymbol.ts:1-12` |
| 语言 | 文件结构（类/方法/字段）弹层 + 符号搜索 | `components/workspace/OutlinePanel.tsx`、`lib/paletteSources.ts:150` |
| 语言 | jar 内类源码（`jdt://` 虚拟标签）可跳可读 | `langProviders.ts:307`、`cli` 侧 `loadJdtSource` |
| 诊断 | jdt.ls 波浪线 + 问题面板 + 上/下一处 | `lib/diagStore.ts`、`components/workspace/BottomPanel.tsx` |
| 编译 | 编译当前模块 / 取消 / 问题列表 / D4 归因（未编译、被停用、产物过期） | `lib/compile.ts`、`src-tauri/src/compile_diag.rs` |
| 导航 | 快速导航四模式（文件/类型/符号/命令）+ 驼峰匹配 | `lib/paletteSources.ts`、`lib/keymap.ts:63-68` |
| 导航 | 后退/前进、最近打开、面包屑 | `lib/navHistory.ts`、`launch` 前存在 `recentFiles`、`Breadcrumb.tsx` |
| 搜索 | 全工程搜索（大小写/整词/正则/IDEA 掩码 `*.java,!test*`）+ 全部替换（跳过不可无损往返的文件） | `lib/search.ts:30-45` |
| 编辑 | 编码/换行无损读写、EOL 统一、UTF-8 提示 | `src-tauri/src/encoding_reg.rs`、`EditorBanners.tsx` |
| 编辑 | 大文件降级（2000 行不再请求语义补全） | `langProviders.ts:35` |
| 历史 | 本地历史（保存前归档、可看旧版、可恢复、可 diff） | `lib/localHistory.ts`、`HistoryPanel.tsx` |
| VCS | SVN 状态/差异/日志/annotate/提交/更新/还原/冲突解决/已审标记 | `src-tauri/src/svn_*`、`commands/svn_cmds.rs` |
| 工程 | 多工程依赖链 + 覆盖表 + 切工作区 + 产物检查 | `eclipse_cp.rs`、`components/tabs/LinkedProjectsTab.tsx` |
| 运行 | NC 服务启动/停止/日志/端口/命令行预览 | `commands/server_cmds.rs`、`ServicesTab.tsx` |
| 数据库 | 连接管理、多会话槽、执行/事务、元数据、导出/导入、会话/锁清单 | `db_*` 全套 |

---

## 2. 缺口矩阵

### A. 代码生成与模板（IDEA 的 Alt+Insert / Live Templates）

| IDEA 功能 | 现状 | 证据 / 影响 |
|---|---|---|
| 生成构造器 / getter / setter / toString / equals / hashCode | **缺 → 现已** | 原：全仓无实现。现：`lib/javaModel.ts` + `lib/javaCodeGen.ts`（纯函数）+ `GenerateDialog.tsx`（Alt+Insert），生成文本插到光标处 |
| 生成 override / implement（`Ctrl+O` / `Ctrl+I`） | **缺 → 现已** | 走 `lib/javaActions.ts` 的 `textDocument/codeAction`（`source.overrideMethods` / `source.implementMethods`），range 覆盖全文 |
| Live Templates（`sout` / `fori` / `psvm` / `ifn` / `null` 判空） | **缺 → 现已** | `lsp.rs:306` 已改 `snippetSupport:true`；`lib/liveTemplates.ts` 注册 19 个模板并按 `insertTextFormat===2` 映射 `InsertAsSnippet`（`langProviders.ts`） |
| 后缀补全（`.var` `.null` `.not`） | **缺** | 无（jdt.ls 0.57 不支持，未做） |
| 自动导入（补全时附带 import） | **有** | `langProviders.ts:245` additionalTextEdits |
| 粘贴时自动 import | **缺** | 无 |
| 新建 Java 类时带 package 声明 / 版权头（File Template） | **缺** | 新建走空文件（`fs_create`），无模板 |
| Organize Imports（`Ctrl+Alt+O`） | **缺 → 现已** | `lib/javaActions.ts:124` 独立命令 + `EditorPane` 绑定 `Ctrl+Alt+O` |

**影响**：这是日常敲键量最大的一块。NC 二开一次写十几个 VO，getter/setter 全靠手打。

### B. 结构浏览与导航

| IDEA 功能 | 现状 | 证据 / 影响 |
|---|---|---|
| 包里类浏览 / 压缩中间包（Compact Middle Packages） | **缺 → 现已** | `lib/treeCompact.ts` + `TreeRows.tsx`，`com → aier → erp → vo` 合成一行；键盘导航与渲染同源 |
| 右侧打开的类自动定位左侧树（auto-reveal / Always Select Opened File） | **缺 → 现已** | `useTreeLoad.ts` 的 `reveal(path)` + `FileTree.tsx` 的 `REVEAL_DELAY_MS` 防抖；只对工作区内路径生效 |
| 「在文件树中显示」命令 | **缺 → 现已** | `lib/revealInTree.ts` 派发 `ncforge-reveal-in-tree`；标签右键 + 命令面板两处入口 |
| 调用层级 Call Hierarchy（`Ctrl+Alt+H`） | **缺（可实现） → 现已** | `lsp.rs:317` 声明 `callHierarchy`；`lib/callHierarchy.ts` 三步取数，`CallHierarchyPanel.tsx` 放底部面板 |
| 类型层级 Type Hierarchy（`Ctrl+H`） | **缺（服务端不支持）** | jdt.ls **0.57 没有** `TypeHierarchyHandler`（后期版本才加）；要做得升级 jdt.ls 或自己拼继承链 |
| 工作区符号搜索（方法/字段级，`Ctrl+Alt+Shift+N`） | **部分 → 现已** | `paletteSources.ts` 的 `sym` 模式（`MEMBER_KINDS`），键位 `Ctrl+Alt+N` |
| 跳转到测试 / 测试到被测 | **缺 → 现已** | `lib/goToTest.ts`：同目录优先、全工作区兜底、找不到时说明找过哪些名字 |
| 上次编辑位置（`Ctrl+Shift+Backspace`）/ 最近位置 | **缺 → 现已** | `lib/editHistory.ts`：只记打字，同位置连续输入只记一条，相邻行不跳 |
| 书签（`F11` / `Ctrl+F11`） | **缺 → 现已** | `lib/bookmarks.ts`（localStorage 按工作区隔离）+ `BookmarkPanel.tsx` |
| 文件树 speed search | **缺 → 现已** | `FileTree.tsx`：可打印字符进筛选，Esc/Backspace 清除；定位前先清筛选 |
| 结构视图（Project 树的文件结构） | **有** | `OutlinePanel.tsx` |

### C. 重构

| IDEA 功能 | 现状 | 说明 |
|---|---|---|
| 重命名（`Shift+F6`） | **有** | 自研，带预览与跨文件写入（`renameSymbol.ts`） |
| 提取变量 / 常量 / 字段 / 参数 / 方法 | **缺** | jdt.ls 不提供重构 API（LSP 标准没有 refactoring） |
| 内联（Inline） | **缺** | 同上 |
| 移动类到包 / 移动成员 | **缺** | 同上 |
| 修改签名（Change Signature） | **缺** | 同上 |
| 安全删除（删前查引用） | **缺 → 现已** | `lib/safeDelete.ts` 按类名 `\bStem\b` 全工程搜索（`*.java,*.xml`），删除确认里给引用数与样本；不用 `textDocument/references`（被删文件多半没打开） |
| 复制类 / 剪切类 | **缺** | 无 |

**结论**：重构要做得自己实现（或内嵌 Eclipse JDT refactoring runtime，成本与红线都高）。
建议只补「安全删除」这种**用现有原语就能拼出来**的。

### D. 代码检查与质量

| IDEA 功能 | 现状 | 证据 / 影响 |
|---|---|---|
| 实时诊断（波浪线 + 问题面板 + 上下跳） | **有** | `diagStore.ts`、`BottomPanel.tsx` |
| 快速修复（`Alt+Enter`） | **有** | `editorActions.ts:130-134` |
| Organize Imports（`Ctrl+Alt+O`） | **部分 → 现已** | `lib/javaActions.ts` 的 `organizeImports`（走 `source.organizeImports`，range 覆盖全文）；原「只能靠 quick fix」 |
| 保存时动作（format on save / optimize imports on save） | **缺** | 全仓无 `formatOnSave`。注意：NC 代码是 CRLF + Tab，**格式化不能默认开**（`lsp.rs:275` 已把 jdt format 关掉） |
| 显式格式化（`Ctrl+Alt+L`） | **待验证** | provider 已注册（`langProvidersExtra.ts:104`），但 `lsp.rs:282` `java.format.enabled:false`；服务端可能返回空，需实测 |
| Inspect Code（批量检查） | **缺** | 只有编辑时诊断 |
| 自定义检查规则 / 严重级别配置 | **缺** | 无 |
| 抑制警告 | **部分** | 只能走 quick fix 提供的 suppress |
| 错误内联显示（Error Lens） | **缺 → 现已** | `lib/errorLens.ts` 行尾装饰（最多 300 条、每条 140 字），偏好里可关 |
| 语义高亮 | **缺（要适配老协议）** | `monacoSetup.ts:5` 用 Monaco 内置 Java Monarch（词法级）。0.57 有 `semantictokens` 包，但走的是**当年的 draft 协议**（`semanticHighlighting` + `SemanticTokensCommand`），不是 LSP 3.16 的标准 `textDocument/semanticTokens`——接 Monaco 得自己翻译一遍 |
| 括号彩虹 / 缩进参考线 | **部分** | 只有主题里的 indentGuide 颜色，无彩虹括号 |

### E. 构建 / 运行 / 调试

| IDEA 功能 | 现状 | 证据 / 影响 |
|---|---|---|
| 编译当前模块 + 取消 + 问题列表 | **有** | `compile_module`、`compile.ts` |
| 按依赖顺序编译全部模块 | **缺** | 只有 `compile_module`（单模块）；D4 记忆里明确未做 |
| 保存即编译（自动构建） | **缺** | 无（jdt.ls 的 autobuild 也关着，`lsp.rs:281`，红线：不写用户文件） |
| 运行单个类 / main 方法 | **缺** | 无 Run Configuration 概念 |
| 调试（断点、单步、变量、表达式求值、attach 到 JVM） | **缺** | 全仓 0 命中（无 JDI/jdb 接入） |
| 单元测试运行（JUnit） | **缺** | 0 命中 |
| 覆盖率 / Profiler | **缺** | 无（建议不做） |

**影响**：NC 排错目前靠日志 + 数据库 + 重新编译。断点调试是最大的能力空白，但成本也最高。

### F. 版本控制

| IDEA 功能 | 现状 | 证据 |
|---|---|---|
| 状态 / 差异 / 日志 / annotate / 提交 / 更新 / 还原 / 冲突解决 | **有** | `commands/svn_cmds.rs` |
| 已审标记（review mark，团队审阅） | **有** | `svn_review.rs` |
| 本地历史 | **有** | `local_history.rs` |
| Change List（变更分组） | **缺** | 无 |
| Shelve / Unshelve（搁置） | **缺** | 无 |
| 与剪贴板比较 | **缺** | 无（`textDiff.ts` 只服务本地历史/SVN） |
| 提交前检查（before commit hooks） | **部分** | 补丁页有表结构核对，但与 SVN 提交未串起来 |

### G. 搜索

| IDEA 功能 | 现状 |
|---|---|
| 全工程文本搜索 + 替换（大小写/整词/正则/掩码） | **有**（`lib/search.ts`、`search.rs`） |
| 搜索历史（最近搜过什么） | **有**（`lib/searchStore.ts:154` 的 localStorage 历史，翻回上次搜的词） |
| 在 jar / 依赖里搜文本 | **缺**（类型搜索覆盖 jar，文本搜索不覆盖） |
| 结构化搜索替换（SSR） | **缺**（建议不做） |
| 双击 Shift 搜索无处不在 | **部分**（Ctrl+K 浮层四模式，接近但不统一） |

### H. 编辑器体验

| IDEA 功能 | 现状 | 证据 |
|---|---|---|
| 多光标（`Alt+J` 选下一个 / 列选择） | **部分 → 现已** | Monaco 内置 Alt+点击、Ctrl+Alt+↓ 之外，`editorActions.ts` 绑了 IDEA 的 `Alt+J`（选下一个相同词） |
| 分屏编辑 | **缺** | 0 命中 |
| 标签拖拽排序 | **缺 → 现已** | `TabStrip.tsx` HTML5 拖拽，拖到哪个标签前就插到它前面 |
| 字号 / 字体 / 换行 / 缩进设置 | **缺 → 现已** | `lib/editorPrefs.ts`（localStorage，不跟配置导出走）+ `components/settings/EditorSettings.tsx`；`monacoOptionsOf` 统一映射 |
| 小地图 / 粘性滚动 | **部分 → 现已** | 小地图默认开（大文件降级时关）；粘性滚动、小地图都可设（`editorPrefs`） |
| 内嵌提示 Inlay Hints（参数名/类型） | **缺（服务端不支持）** | jdt.ls 0.57 无 InlayHint handler（LSP 3.17 之后才有）；自己做要算参数名映射，收益低 |
| 代码折叠 | **部分（可补） → 现已** | `langProvidersExtra.ts` 加 `FoldingRange` provider（`lsp.rs:314` 声明 `foldingRange`），按方法/块折叠 |
| 当前符号所有出现处高亮（`Ctrl+Shift+F7`） | **缺（可补） → 现已** | `langProvidersExtra.ts` 加 `DocumentHighlight` provider（`lsp.rs:315`），语义级高亮 |
| 扩展选区（`Ctrl+W` 逐层选中） | **缺（可补） → 现已** | `langProvidersExtra.ts` 加 `SelectionRange` provider（`lsp.rs:316`），限 32 层防成环 |
| 自动保存 | **缺 → 现已** | `editorPrefs.autoSave`（默认关：NC 常「改一半就编译」，自动落盘会打断节奏），延迟可设 |
| 编码 / 换行处理 | **有** | `encoding_reg.rs`、EOL 横幅 |

### I. 工程 / 工作区

| IDEA 功能 | 现状 |
|---|---|
| 多工程依赖链 + 覆盖表 + 切工作区 | **有**（`LinkedProjectsTab` 已实现） |
| 任意多 root 同时打开 | **部分**（语义 = 主工程 + 依赖闭包；不是任意多 root） |
| 源码根标记 / 排除目录 UI | **缺**（由 `.classpath` 决定，有意不做 UI） |
| 外部文件变更自动刷新（file watcher） | **缺**（0 命中；树只在展开/手动刷新时读盘） |
| 文件树按名字过滤（speed search） | **缺 → 现已**（见 B 节：`FileTree.tsx` 可打印字符即筛选） |

---

## 3. 按 ROI 的补齐顺序

工作量按"熟悉仓库的人"估算。P0 = 直接减少日常敲键/点击，P1 = 导航与结构，P2 = 大件。

### P0（建议下一批就做，合计约 6~8 天）

| # | 项 | 估计 | 要点 | 状态 |
|---|---|---|---|---|
| 1 | 代码生成：构造器 / getter / setter / toString / equals / hashCode | 1.5 d | 不依赖 jdt.ls（它不提供）；从源码 AST 或正则拿字段名，生成文本插到光标处；需要「字段来自父类/当前类」的判断 | **已落地** |
| 2 | 生成 override / implement 方法 | 1 d | 可用 `textDocument/codeAction` 的 `source.overrideMethods` / `source.implementMethods`（jdt.ls 支持），先验证再决定要不要自己做 | **已落地** |
| 3 | Live Templates（`sout` / `fori` / `ifn` / `null` 判空 / `psvm`） | 1 d | 要把 `lsp.rs:303` 的 `snippetSupport` 改 true + Monaco 处理 `insertTextFormat=2`（snippet）。**注意**：jdt.ls 自己的模板会一起进来，要先测有没有格式错乱 | **已落地** |
| 4 | 包里类浏览（压缩中间包）+ 右侧类自动定位左侧树 + 「在文件树中显示」 | 2 d | 上一轮已给方案；`useTreeLoad` 加 `reveal(path)`；单文件 ≤300 行 / hooks ≤8 | **已落地** |
| 5 | Organize Imports 独立命令（`Ctrl+Alt+O`） | 0.5 d | 走 `textDocument/codeAction` 的 `source.organizeImports`；**先验证** jdt.ls 是否返回 | **已落地** |
| 6 | 编译全部模块（按依赖顺序） | 1 d | `compile_module` 扩成多模块编排；顺序用 `eclipse_cp` 的 projects（已具备）；要能取消、要汇总问题 | **已落地** |
| 7 | Error Lens（行尾内联显示诊断） | 0.5 d | Monaco decoration，数据源 `diagStore`；注意与波浪线重复的视觉噪音，给开关 | **已落地** |

### P1（约 7~8 天）

| # | 项 | 估计 | 要点 | 状态 |
|---|---|---|---|---|
| 8 | 调用层级（`Ctrl+Alt+H`） | 1.5 d | `lsp.rs` 加 `callHierarchy` 声明（**0.57 有 handler，已核实**）；结果放底部面板；注意 jdt.ls 返回的是 `item` 引用，再请求 incoming/outgoing | **已落地** |
| 8b | 代码折叠（按方法/块）+ 当前符号高亮 + 扩展选区 | 1.5 d | 三个都是 0.57 已有 handler、前端只缺 provider 的低成本项（`FoldingRangeHandler` / `DocumentHighlightHandler` / `SelectionRangeHandler`） | **已落地** |
| 9 | 工作区方法级符号搜索 | 0.5 d | `paletteSources.ts` 的 `TYPE_KINDS` 放开到方法/字段，加模式或混淆排序 | **已落地**（新增 `sym` 模式，`Ctrl+Alt+N`） |
| 10 | TODO 面板（`TODO` / `FIXME` / `XXX`） | 1 d | 复用 `search_workspace` 正则扫描，结果进底部面板；不要每次打开都全盘扫，缓存 + 手动刷新 | **已落地** |
| 11 | 书签（文件 + 行，两侧显示） | 1 d | 状态进 `workspaceSession`；树行与编辑器 gutter 打点 | **已落地**（localStorage 按工作区隔离，未进 `workspaceSession`） |
| 12 | 文件树 speed search（输入过滤）+ 文件 watcher | 1.5 d | 过滤纯前端；watcher 用 `notify` crate，注意 NC 工作副本 `.svn` 目录噪音 | **speed search 已落地**；file watcher 未做 |
| 13 | 搜索历史 | 0.5 d | localStorage 按工作区隔离；`patchDraft` 有现成范式 | **原本就有**（`searchStore.ts:154`，当时漏查） |
| 14 | 安全删除（删前查引用） | 0.5 d | 复用 `textDocument/references`，0 引用才允许直接删 | **已落地**（改成按类名全工程搜索，见 §7 第 14 条） |

### P2（大件，按需）

| # | 项 | 估计 | 说明 |
|---|---|---|---|
| 15 | 调试器（JDI attach 到 NC 服务 JVM） | 8~15 d | 最大价值也最大成本：需要 JDI 桥、断点管理、变量树、单步、表达式求值；NC 启动参数还要加 `-agentlib:jdwp`（会与 `launch.rs` 的 VM 参数生成耦合） |
| 16 | 重构（提取方法/变量、内联、移动） | 10 d+ | jdt.ls 不支持；要自己写 Java AST 变换（可用 javaparser）或内嵌 Eclipse JDT。与「不写用户文件」红线需要重新设计预览/保存流程 |
| 17 | 终端 | 3 d | 纯前端 xterm + 后端 pty；NC 场景有 SVN UI 后需求不高 |
| 18 | 类型层级（`Ctrl+H`） | 3 d+ | **卡在 jdt.ls 0.57 没有 TypeHierarchyHandler**：要么升级 jdt.ls（要验 NC 的 Java 8 / 影子工程 / 0.57 特有的坑），要么自己用 `typeDefinition` + `references` 拼继承链（只能近似） |
| 19 | 语义高亮（semantic tokens） | 3 d | 0.57 的语义高亮是 draft 协议（`semanticHighlighting` + `SemanticTokensCommand`），要自己转成 Monaco 的 semanticTokens 格式；还要维护「token 类型 → 主题色」映射，与现有 Monarch 词法色逐类对齐 |

---

## 7. 本轮落地清单（2026-11-01，P0 + P1 主体）

约定同 §5 第 4 条：**所有生成/修复只落到 Monaco model，不写用户文件**。

| # | 能力 | 前端 | 后端 | 单测 |
|---|---|---|---|---|
| 1 | 代码生成（Alt+Insert） | `lib/javaModel.ts`、`lib/javaCodeGen.ts`、`components/workspace/GenerateDialog.tsx` | — | `javaModel.test.ts`、`javaCodeGen.test.ts` |
| 2 | override / implement | `lib/javaActions.ts`（`source.overrideMethods` / `source.implementMethods`，range 覆盖全文） | — | — |
| 3 | Live Templates | `lib/liveTemplates.ts`（19 个）+ `langProviders.ts` 的 `insertTextRules` | `lsp.rs:306` `snippetSupport:true` | `liveTemplates.test.ts` |
| 4 | 压缩中间包 + 自动定位 + 在文件树中显示 | `lib/treeCompact.ts`、`TreeRows.tsx`、`useTreeLoad.ts` 的 `reveal`、`lib/revealInTree.ts`、`TreeChrome.tsx` | — | `treeCompact.test.ts` |
| 5 | Organize Imports | `lib/javaActions.ts:124`（`Ctrl+Alt+O`） | `lsp.rs:322` codeActionKind 白名单 | — |
| 6 | 编译全部模块 | `lib/compile.ts` 的 `compileAllModules`、`useModuleCompile.ts` 的 `build.compileAll` | `compile_cmds.rs:256` `compile_all_modules`；顺序取类路径倒序（`eclipse_cp::compile_order`），首个失败即停 | `eclipse_cp.rs` 3 条 |
| 7 | Error Lens | `lib/errorLens.ts`（最多 300 条、每条 140 字）+ `error-lens.css` | — | `editorPrefs.test.ts` 覆盖开关 |
| 8 | 调用层级 | `lib/callHierarchy.ts`、`components/workspace/CallHierarchyPanel.tsx` | `lsp.rs:317` `callHierarchy` | — |
| 8b | 折叠 / 当前符号高亮 / 扩展选区 | `lib/langProvidersExtra.ts` 三个 provider | `lsp.rs:314-316` | — |
| 9 | 工作区符号搜索 | `lib/paletteSources.ts` 的 `sym` 模式 + `lib/keymap.ts` 的 `Ctrl+Alt+N` | — | `paletteSources.test.ts`、`keymap.test.ts` |
| 10 | TODO 面板 | `lib/todoScan.ts`、`TodoPanel.tsx` | — | — |
| 11 | 书签 | `lib/bookmarks.ts`、`BookmarkPanel.tsx`（`F11` / `Shift+F11`） | — | `bookmarks.test.ts` |
| 12 | speed search | `FileTree.tsx` | — | — |
| 13 | 搜索历史 | 既有（`searchStore.ts:154`） | — | — |
| 14 | 安全删除 | `lib/safeDelete.ts` + `useTreeDelete.ts` 的引用提示 | — | `safeDelete.test.ts`、`treeDeleteText.test.ts` |
| — | 编辑器体验（H 节） | `lib/editorPrefs.ts`、`EditorSettings.tsx`、`TabStrip.tsx` 拖拽、`Alt+J` | — | `editorPrefs.test.ts` |
| — | 上次编辑位置 / 跳转到测试 | `lib/editHistory.ts`、`lib/goToTest.ts` | — | `editHistory.test.ts`、`goToTest.test.ts` |

**实现中踩到并修掉的坑**（都在单测里钉住）：

1. `toString` 每行必须以 `+` 结尾（Java 不允许操作数后换行续写）。
2. `equals` 必须逐字段 `Objects.equals(a, that.a)`——`Objects.equals(a, b)` 没有多参数重载，
   会退化成 `Object[]` 引用比较，永远 false。
3. `snippetSupport` 打开后前端必须把 `insertTextFormat===2` 映射成 `InsertAsSnippet`，
   否则 `${1:x}` 原样进代码。
4. 调用层级的 incoming/outgoing 必须回传服务端原始 `item`（带 `data` 字段），
   自己转的结构会让第二步请求失败。
5. 压缩中间包的展开/收起要写/删**链上每一层**（`chainFor`），只动链尾会"点了没反应"。
6. 编译顺序按类路径倒序去重时，模块名要保留原始大小写（调用方拿它拼 `<root>/<module>`）；
   直接挂在根下的那一层（追加目录、根工程自己的 `classes`）不是模块。
7. 定位与筛选互斥：`reveal()` 前先清 filter，否则"定位成功但看不见"。

---

## 4. 明确不建议做

| 项 | 理由 |
|---|---|
| Profiler / 覆盖率 / 依赖 UML 图 | 与 NC 二开场景无关，维护成本高 |
| 完整 JDT 重构 API 接入 | 要跑 Eclipse runtime，写文件行为与现有红线（只落到编辑器、用户自己保存）冲突 |
| 结构化搜索替换（SSR） | 全工程正则替换已够用 |
| HTTP Client | NC 前端是 JSP/upm，不走这个路径 |
| 保存时自动格式化 | NC 代码是 CRLF + Tab，`lsp.rs:282` 已刻意关掉 jdt format；开了会大面积改脏文件 |

---

## 5. 落地时的技术约束（踩过的）

1. **改 LSP 能力要改 `lsp.rs:294-322`**，只加前端 provider 不够：jdt.ls 按 `initialize` 的
   capabilities 决定给不给结果。**但先确认 0.57 有没有对应 handler**——本机
   `org.eclipse.jdt.ls.core_0.57.0` 里核实过：有 `CallHierarchy`（`prepareCallHierarchy` +
   incoming/outgoing）/ `FoldingRange` / `DocumentHighlight` / `SelectionRange` / `CodeLens`，
   语义高亮是 draft 协议；**没有 `TypeHierarchy` 与 `InlayHint`**。别按新版 jdt.ls 的文档规划。
2. **`snippetSupport` 现在是 `true`**（`lsp.rs:306`）。前端按 `insertTextFormat===2` 映射到
   Monaco 的 `InsertAsSnippet`（`langProviders.ts`）；jdt.ls 自己的模板也会一起进来，
   排序上让内置模板靠后（`sortText: "zz-<prefix>"`），敲半截时语义补全仍排前面。
3. **格式化有三个开关要一起看**：`lsp.rs:282` `java.format.enabled:false`（服务端配置）、
   `langProvidersExtra.ts:104`（前端 provider）、`editorActions.ts:59`（命令）。
   现状很可能"命令点了没反应"，需实测后决定是修还是删。
4. **代码生成不要走 jdt.ls 的 `workspace/applyEdit`**：红线是 jdt.ls 不写用户文件
   （`lsp.rs:292` 注释）。生成结果作为文本插入编辑器，用户自己保存。
   override/implement 的 `codeAction.edit` 由前端自己 apply 到当前 model，
   跨文件编辑丢弃并计数告知。
5. **单文件门禁**：≤300 行、`useState+useEffect` ≤8（`scripts/check-component-size.mjs:33-34`）。
   新面板（调用层级/TODO/书签）必须拆件。
6. **`useSyncExternalStore` 快照要稳定引用**（`diagStore.ts:34-39` 已按此写）；
   新面板的数据源照抄这个模式，别每次 filter 出新数组。
7. **jdt.ls 版本是硬边界**：内置 0.57.0（`scripts/fetch-jdtls.mjs:45`）。升级它要重验
   影子工程、类文件读取（`jdt://`）、NC 的 Java 8 运行时兼容——0.57 是新版编号体系之前的
   最后一个里程碑，升级不是"换个下载链接"这么简单。凡标「0.57 没有」的能力，先别排进迭代。

---

## 6. 动手前先验证的四件事

1. **格式化到底能不能用**：在 Java 文件里跑「格式化当前文件」，看有没有改动。
2. **jdt.ls 是否返回 organizeImports / override / implement 的 code action**：
   打日志看 `textDocument/codeAction` 的返回，或在 quick fix 菜单里找。
3. **snippet 模板开启后的插入效果**：临时把 `snippetSupport` 改 true，敲 `for` 看补全项插入结果。
4. **补了 capabilities 之后 handler 是否真的被注册**：加完 `callHierarchy` 声明，打一条
   `textDocument/prepareCallHierarchy` 请求看返回；0.57 有 handler 不等于它会给所有客户端注册
   （部分是动态注册，要看 `client/registerCapability` 有没有来）。

这四件都影响具体做法，建议动手前各花 10 分钟实测。
