# 借鉴 Lithe-IDEA：轻量 IDE 的运行时、性能预算与插件边界

> 2026-11-04。对象：GitHub [`1lck/Lithe-IDEA`](https://github.com/1lck/Lithe-IDEA)，Apache-2.0，最新 v0.6.7。
> 本文只回答一件事：**Lithe 哪些长处值得 NCForge 学，怎么学，哪些不学**。
> 证据以仓库源码、README 和 `.agents/notes` 架构笔记为准；star、安装包大小、下载量为 2026-11-04 快照。

---

## 0. 结论先行

Lithe 的低内存不是「少画 UI」，而是「**没有能力请求就不构造，构造了就登记资源，停用就真停**」。

| # | 长处 | Lithe 的具体做法 | NCForge 现状 | 建议 |
|---|---|---|---|---|
| A | **模块运行时** | manifest + 依赖图 + 能力 + `ModuleResourceScope` + `ModuleLease`；禁用模块不启动进程/watcher/timer | 重资源生命周期未统一，需先测 | **P1**：先测泄漏，再抽轻量 registry；不照搬完整 kernel |
| B | **可执行性能预算** | 14 个交互场景、三十多项指标，写进 `budgets.json`，CI 按 20% 容忍卡回归 | 有体量/包体/动效门禁，无交互级预算 | **P0**：建基线 + budgets + 泄漏检查 |
| C | **懒树与编辑器复用** | 平铺快照 + 展开时 `listDirectories`；每窗格 8 个 Monaco surface 轮换 | 已有懒树、单 Monaco 实例 + `setModel` | 补语义和边界，不照搬 surface 池 |
| D | **单一 Rust Core + 契约** | 共享行为只在 `lithe-core`；前端只走 `@/platform/tauri-core`；契约 + fixture 先行 | 已有命令契约生成/校验 | 补反例 fixture、稳定错误码、边界 verify |
| E | **声明式插件 + 治理** | 插件不加载宿主代码；能力分版本；Agent Note + verify 脚本 | 有 NC 插件借鉴方案，未见统一插件模型 | 先定 capability/权限，再定 manifest |

最该先补的是 **B（交互级性能预算和内存基线）**，不是重写架构。没有基线，A/C 的改造无法证明有效。

---

## 1. 事实校正：它是什么，不是什么

### 1.1 仓库画像

| 项 | 值（2026-11-04） |
|---|---|
| 仓库 | `1lck/Lithe-IDEA` |
| 许可 | Apache-2.0 |
| 创建时间 | 2026-08-02 |
| Stars / Forks | 2,495 / 215 |
| 最新版本 | v0.6.7（2026-11-04） |
| 仓库体积 | 约 181 MB |
| Windows 安装包 | `Lithe-0.6.7-windows-x64.exe`，约 263 MB |
| macOS 安装包 | `Lithe-0.6.7-arm64.dmg`，约 354 MB |

### 1.2 技术栈

- macOS：SwiftUI / AppKit 原生界面，当前参考产品。
- Windows：React + Tauri，独立实现，但共享 Rust Core 和 Monaco。
- 共享层：`rust/lithe-core`、JSON 契约与 fixture、共享 Monaco 编辑器。
- 插件：声明式 `plugin.json`，不在宿主进程加载插件代码。

它不是 IntelliJ IDEA 的分支，也不是「Rust 原生 IDE」。CSDN 上「47MB、Rust 原生、312MB 内存、4.2k stars」等说法互相矛盾，与仓库实际不符，不能作为依据。

### 1.3 「300–400 MB」怎么读

README 原文是：

> The Lithe application typically uses about **300–400 MB of baseline memory** after opening a regular project. Language servers, terminals, build tools, and debuggers start on demand.

这是作者口径，不是独立基准，且明确排除了按需启动的语言服务器、终端、构建和调试器。可以当设计目标，不能当实测结论。要引用，必须自己在本机按同一口径测量，并写清进程范围。

### 1.4 供应链提醒

GitHub 上存在搬运/仿冒仓库（例如带「Official Build」字样但无社区背书的仓库）。安装包只认 `1lck/Lithe-IDEA` 的 Releases；macOS 包目前还存在未公证提示，首次打开需要手动放行。评估可以，别把第三方打包产物当官方版本。

---

## 2. 五条长处

### 2.1 模块运行时：低内存的机制，不是结果

证据：[模块运行时边界与生命周期](https://github.com/1lck/Lithe-IDEA/blob/main/.agents/notes/implemented/architecture/2026-09-13-module-runtime-boundaries-and-lifecycle.md)。

核心结构：

```text
MacServiceContainer
    -> ModuleRegistry
        -> ModuleRuntime
            -> ModuleFactory
                -> LitheModule
```

它把「功能模块」从 UI 目录提升为运行时对象，并规定了几条硬不变量：

1. 禁用、隔离或 Safe Mode 抑制的模块**不调用 factory**，也不启动 task、timer、session、watcher、连接或子进程。
2. `onDemand` 模块只有声明的能力被请求或被显式激活时才构造；依赖先激活；依赖图无环；能力提供者不能静默覆盖。
3. 每个长期资源只能登记到一个 `ModuleResourceScope`；注销活动资源会被拒绝，先停资源再释放登记。
4. `ModuleLease` 表示不可中断工作。运行、测试、调试、终端、导入导出、事务必须持 lease；存在活动 lease 时，休眠失败并发布可观察的阻塞原因。
5. 休眠依次准备模块、停止服务、停止资源、确认无活动资源、移除能力和贡献、释放实例；唤醒重新构造并先激活依赖。
6. 可选模块在调用 factory 前写 pending activation 标记；下次启动若标记未清，先把模块隔离，应用仍可启动并让用户重新启用。
7. 静态贡献目录可以在**不构造模块**的情况下被工作台读取；模块激活后才发布实际贡献。
8. 同一模块的并发激活/关闭合并；UI 取消只撤回自己的等待，不取消其他窗口共享的构造。
9. 模块仍在应用进程内运行；隔离和 Safe Mode 是下次启动的恢复机制，不等同于进程隔离。

**为什么有效**：它解决的不是「页面没打开」，而是「功能关了，PTY、watcher、数据库连接、子进程还在后台吃内存」。多数轻量 IDE 只做到不渲染，Lithe 做到了不持有。

**代价**：模块 API、注册表、依赖校验、休眠/唤醒、恢复标记都要维护。对 NCForge 现阶段，先借「资源 scope + lease + 停用即停」这三条，不必先建完整依赖图。

### 2.2 性能预算：把「快」变成可执行断言

证据：[Windows budgets.json](https://github.com/1lck/Lithe-IDEA/blob/main/scripts/windows/perf/budgets.json)。

- 14 个交互场景：startup、openProject、typing、typingLarge、typingBursts、textBlockRecolor、keyRepeat、scroll、tabs、fileOpen、projectTree、quickOpen、commandPalette、leaks。
- 三十多项指标，延迟从**输入事件**算到**首帧显示结果**；约 16.7ms 就是「下一帧」。
- 回归容忍：20%，下限 1ms；低于下限的抖动不算回归。
- 预算示例：

| 指标 | 预算 |
|---|---|
| `startup.readyMs` | 1000 |
| `startup.initialJsKb` | 2000 |
| `openProject.openMs` | 200 |
| `typing.p95Ms` / `maxMs` | 20 / 33 |
| `typing.mainThreadMsPerKey` | 14 |
| `tabs.switchP95Ms` | 33 |
| `fileOpen.pastLimitOpenP95Ms` | 66 |
| `projectTree.frameMaxMs` | 33 |
| `quickOpen.openMs` / `queryMs` | 50 / 200 |
| `leaks.heapGrowthMb` / `listenerGrowth` | 8 / 4 |

**为什么有效**：性能讨论从「感觉卡」变成「哪个场景、哪个指标、超了多少」。改架构前先有数字，改完能证明没退化。

**NCForge 可借的点**：我们已有 `bundle:check`、组件体量门禁、`motion:check`，缺的是**交互级**场景和**内存泄漏**门禁。这两类门禁不能靠构建产物大小替代。

### 2.3 两个具体案例

#### 2.3.1 懒项目树

证据：[macOS 项目树按需列目录](https://github.com/1lck/Lithe-IDEA/blob/main/.agents/notes/implemented/architecture/2026-10-19-lazy-project-tree.md)。

- 快照只返回平铺文件清单，不再返回整棵树。
- 目录行初始为「未加载」，展开时才 `workspace.listDirectories` 列下一层。
- 主仓 6.5k 文件时快照 JSON 约 1.37 MB；有嵌套 worktree 时可膨胀到十几万文件、42 MB。
- `children == nil` 表示未加载，不是空目录；查找和编辑必须处理「路径在未加载行下面」。
- 增量更新用 `FileNode.TreeEdit` 表达：未加载行下返回 `.unchanged`；可能影响包压缩布局时 `.reload`；否则 `.updated`。
- 包压缩的末端目录列表做临时复用缓存：最多 128 个目录、合计 4096 个子项；身份包含工作区和可见性规则；文件事件立即失效。
- 单子目录链在后台一次读完，最多 64 层，遇到分叉停止，避免用户看到逐级展开。
- 实现参考了 IDEA 的 `AsyncTreeModel` 和 `VirtualDirectoryImpl`，不是拍脑袋。

**对 NCForge**：我们已有 `useTreeLoad` + `listDir` 的懒加载，方向一致。缺口是「未加载 vs 空目录」语义、批量加载、展开链一次发布、缓存上限、事件代次。多工程合并树更需要这些边界。

#### 2.3.2 编辑器表面复用

证据：[Windows 编辑器表面复用与标签上限](https://github.com/1lck/Lithe-IDEA/blob/main/.agents/notes/implemented/architecture/2026-10-30-windows-editor-surface-reuse.md)。

- 每个窗格最多保留 8 个已挂载的 Monaco 编辑器表面（实例 + DOM）。
- 打开第 9 个文件时，不销毁重建，而是把最久未用的表面改绑到新文件，只切 model。
- 越过挂载上限打开文件：约 94ms → 42ms。
- 8 / 20 / 30 / 40 个标签时打开新文件约 40 / 42 / 44 / 49ms；每多一个标签约增加 0.2MB 堆。
- 隐藏标签用 `content-visibility: hidden` + `visibility: hidden`；前者跳过样式和布局但保留尺寸，后者防止空槽位接收点击。
- CodeLens 和语义高亮对「只被隐藏表面显示」的 model 跳过请求，显示时再刷新。
- 标签上限只有一份实现，统一在 `buffer-eviction.ts`；已固定、未保存、终端、Agent、外部编辑器等标签不计数、不关闭；0 表示不限。

**对 NCForge**：我们的 `EditorPane` 每个窗格只创建一个 Monaco 实例，切文件只 `setModel`，机制上比 8-surface 池更省，不需要照搬。真正要借的是两条纪律：

1. 编辑器级处理函数放创建 effect，通过 ref 读取当前文件；按文件的状态放 model effect，随文件建立和清理。
2. 属性文件的状态（监听、gutter、菜单、装饰）必须在 model effect 清理时重置，否则会带到下一个文件。

### 2.4 单一 Rust Core + 契约

证据：[Windows 架构说明](https://github.com/1lck/Lithe-IDEA/blob/main/windows/README.md)。

- 前端只 import `@/platform/tauri-core`，不直接碰 `@tauri-apps/api/core`。
- Tauri 平台命令负责终端、watcher、凭据等原生能力；共享行为通过 `platform_invoke` / `core_execute` 进入 `lithe-core`。
- React 只负责呈现和 UI 状态；搜索、Git、历史、语言、运行配置、文件行为都在 Core。
- 新共享行为必须先加契约和 fixture，两个产品再消费；`verify-shared-contracts.sh` 还会拒绝契约目录内的越界相对链接。
- 同一份契约在 `lithe-plugin-docs` 仓库保留逐字节副本，SDK 的端到端测试跟着契约走。

**为什么有效**：多端/多壳子最怕「Swift 修了、Windows 没修」和「各写一遍语义漂移」。契约先行把行为差异变成可测试的差异。

**NCForge 可借的点**：我们已有 `contract:generate` / `contract:check`，下一步是把契约从「命令签名」扩展到「合法/非法输入 + 稳定错误码 + fixture」。这比再加一层抽象更划算。

### 2.5 声明式插件与工程治理

证据：[声明式语言插件与进程外执行](https://github.com/1lck/Lithe-IDEA/blob/main/.agents/notes/implemented/architecture/2026-10-12-declarative-language-plugins.md)、[AGENTS.md](https://github.com/1lck/Lithe-IDEA/blob/main/AGENTS.md)。

**插件模型**：

- 官方语言插件只有 `plugin.json` 和声明的资源，不在宿主进程加载任何代码。
- Rust Core 做清单校验、命令模板展开；宿主模块启动语言服务器和运行进程，进程仍由模块资源范围持有。
- 兼容性只看 `pluginAPIVersion`，并按能力分版本；不再用宿主版本号冒充插件 API 版本。
- 官方、publisher、社区包分信任等级；磁盘安装先复制到私有快照再审查，保存完整程序清单和内容摘要，回滚来源与市场来源分开记录。
- 三个后端 SDK（Node、Java、Rust）和契约文档独立仓库维护，示例后端做端到端测试。

**治理**：

- `AGENTS.md` 只放入口和「先读哪个 Skill」，具体规则放 Skill，避免三份规则漂移。
- 架构决策用 Agent Note，固定结构：**先说结论 → 问题 → 决策 → 必须保持的不变量 → 备选方案 → 后果 → 验证**，并附 issue 编号和上游参考。
- `scripts/architecture/verify-*.sh` 把模块边界、服务边界、共享契约、编辑器边界、Java 语义归属变成可执行断言。
- i18n 单一来源生成；发行目录运行时只读；测试启动的进程必须清理；跨平台功能矩阵单独维护。
- PR 默认 Draft，只跑 Linux 检查；本地验证通过再 ready，减少 CI 用量。

**为什么有效**：一个三个月冲到 2.5k stars、双端 + 插件 + 多语言的项目，靠的不是文档多，而是**文档解释 why、脚本守住 what、笔记记录取舍**。

---

## 3. 对 NCForge 的映射

### 3.1 现状盘点

| 能力 | NCForge 现状 | 证据 |
|---|---|---|
| 懒文件树 | 已有：`useTreeLoad` 按目录 `listDir` | `desktop/src/components/workspace/useTreeLoad.ts` |
| 多工程合并树/搜索 | 已有 | 提交 `69427c4` |
| 编辑器实例 | 每窗格一个 Monaco，切文件 `setModel` | `desktop/src/components/workspace/EditorPane.tsx` |
| 命令契约 | 已有生成与校验 | `desktop/scripts/gen-command-contract.mjs`、`contract:check` |
| 体量门禁 | 已有包体、组件体量、动效、token、UI 契约 | `desktop/package.json` scripts |
| 交互性能预算 | 未发现 | 无 `perf` 场景/预算文件 |
| 内存基线/泄漏门禁 | 未发现 | 无相关脚本 |
| 重资源统一生命周期 | 未确认，需基线定位 | jdtls、DB、SVN、终端、下载分散在各 feature |
| 插件模型 | 有 NC 插件借鉴方案，未见统一 manifest | `docs/NCForge-借鉴-idea_plugin_ncdevplugin-20261031.md` |

### 3.2 逐项动作

#### P0：先建基线，再谈优化

目标：知道 NCForge 现在到底占多少内存、哪些交互慢、关掉功能后有没有残留。

建议指标（先少后多）：

| 场景 | 指标 | 采集方式 |
|---|---|---|
| 冷启动 | ready 时间、首屏 JS/CSS 体积 | 前端 `performance` + 构建产物 |
| 开工程 | 首帧时间、树根渲染时间 | Playwright / WebView2 CDP |
| 开文件 | 文件打开到首帧、monaco model 创建时间 | 同上 |
| 树展开 | 单帧最大耗时、批量加载耗时 | 同上 |
| Quick Open | 打开耗时、查询耗时 | 同上 |
| 输入 | p95 / max、每键主线程耗时 | 同上 |
| 空闲内存 | 主进程 + WebView2 子进程 RSS 合计 | Rust 侧按进程树采样 |
| 关闭后 | 关闭工程/标签后的 RSS 回落、监听器/定时器数量 | 同上 + 前端计数 |
| 泄漏 | 反复开合 50 次后的堆增长 | `performance.memory` 或 CDP heap |

落地建议：

1. `desktop/scripts/perf/budgets.json`：键为 `<scenario>.<metric>`，值取本机三次中位数；回归容忍 20%、下限 1ms。
2. `desktop/scripts/perf/run-perf.mjs`：Playwright 通过 CDP 连接 WebView2。Tauri 需设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`；本机有代理时给 localhost 加 `--no-proxy-server` 或 `NO_PROXY`。
3. Rust 侧加一个只读采样命令：用 `sysinfo` 按父进程聚合应用进程树 RSS，输出 JSON；不引入常驻监控线程。
4. 先记录、不设卡；跑一周稳定后再把预算接进 CI，避免第一天就被环境抖动卡住。
5. 同法实测 Lithe v0.6.7，按「应用 + WebView + Rust」和「全部子进程」两种口径分别记录，验证 300–400MB 的说法。

**验收**：仓库内有一份可复跑的基线报告，包含机器、版本、场景、三次采样和进程范围；后续改动能对比同一场景。

#### P1：轻量资源生命周期

先不建完整 ModuleRuntime。最小闭环：

- Rust 侧一个 `FeatureResourceRegistry`：按 feature id 登记子进程、文件 watcher、定时器、连接；`stop(feature)` 必须幂等，返回未释放资源清单。
- 一个 `Lease` guard：运行、调试、导入导出、长事务持有；关闭工程/停用功能时先等 lease 释放，超时要报告阻塞原因，不能静默杀进程。
- 前端功能模块声明 `activate/deactivate`；停用后不再发请求，Rust 侧对应资源全部停止。
- 关闭工程要有明确完成边界：像 Lithe 的 `awaitModuleRuntimeShutdown()` 一样，语言服务、树、搜索、终端都等待同一轮清理，不能靠延时。

**验收**：停用 DB / SVN / 语言服务 / 终端后，进程树和句柄数回落到基线；关闭工程 5 秒内没有残留子进程。

#### P2：契约与决策记录

- 给 `gen-command-contract.mjs` 增加合法/非法 fixture 和稳定错误码；新增 `verify-contract-fixtures` 脚本。
- 边界校验脚本优先做三条：前端不得直接 import `@tauri-apps/api/core`、共享行为不得在 UI 层二次实现、发行目录运行时只读。
- 决策记录统一模板：先说结论 / 问题 / 决策 / 不变量 / 备选 / 后果 / 验证。现有 `docs/` 下的方案和验收文档可以保持原格式，新决策按模板追加。

**验收**：契约变更时，反例 fixture 能让 CI 失败；边界违规有具体报错和修复指引。

#### P3：插件模型（有生态需求再做）

- 先定 capability 和权限模型，再定 manifest；不要先写插件加载器。
- 需要深度宿主钩子的 NC 业务插件，不能强行进程外；可以分「声明式轻插件」和「受信任宿主扩展」两档，分别定义信任和恢复策略。
- 插件契约和 SDK 分仓库维护时，必须像 Lithe 一样做逐字节同步和端到端示例测试。

---

## 4. 不照搬与风险

| 不照搬 | 原因 |
|---|---|
| 完整 `ModuleRuntime` / `LitheApplicationKernel` | 依赖图、休眠、Safe Mode、并发激活合并都很重；NCForge 可选原生模块没那么多，先做 registry + lease 足够 |
| 8-surface 编辑器池 | 我们每窗格已经是单实例 + `setModel`，更省；照搬反而增加状态复杂度 |
| SwiftUI/AppKit 架构 | Tauri + React + Rust 是我们的既定路线，Windows 优先 |
| 把 300–400MB 当 KPI | 作者口径，未含 LSP/构建/调试；必须先按统一口径实测 |
| 插件一律进程外 | 深度宿主集成场景会失去能力；应按信任等级分档 |

**其他风险**：

- 不要用 CSDN 二手测评里的数字做立项依据；同一项目在不同文章里技术栈、体积、star 数互相矛盾。
- Lithe 本身仍在快速迭代，Windows 与 macOS 存在功能差异（例如数据库插件目前仅 macOS），引用时要标版本和平台。
- 仿冒/搬运仓库和第三方打包有供应链风险，只认官方 Releases。

---

## 5. 建议的下一步

1. **先做 P0 基线**：在本机测 NCForge 的启动、开工程、开文件、树展开、Quick Open、输入、空闲内存、关闭后残留；产出一份可复跑报告。
2. 用同一套方法测 Lithe v0.6.7，把「300–400MB」拆成应用、WebView、Rust、LSP/构建/调试四类，确认差距在哪。
3. 基线出来后再决定 P1 的范围：如果残留主要来自子进程/watcher，先做 registry + lease；如果主要来自前端堆，先做标签/树/模型的释放策略。

**本文不改代码**。P0 脚本落地后再单独出实施任务。

---

## 附录：证据索引

| 结论 | 证据 |
|---|---|
| 仓库信息、安装包、版本 | GitHub API `repos/1lck/Lithe-IDEA`、Releases v0.6.7 |
| 300–400MB 口径 | [README.md](https://github.com/1lck/Lithe-IDEA/blob/main/README.md) |
| 模块运行时与资源/lease 规则 | [2026-09-13-module-runtime-boundaries-and-lifecycle.md](https://github.com/1lck/Lithe-IDEA/blob/main/.agents/notes/implemented/architecture/2026-09-13-module-runtime-boundaries-and-lifecycle.md) |
| 性能预算与场景 | [budgets.json](https://github.com/1lck/Lithe-IDEA/blob/main/scripts/windows/perf/budgets.json)、`scripts/windows/perf/scenarios.mjs` |
| 懒项目树数字与语义 | [2026-10-19-lazy-project-tree.md](https://github.com/1lck/Lithe-IDEA/blob/main/.agents/notes/implemented/architecture/2026-10-19-lazy-project-tree.md) |
| 编辑器表面复用数字 | [2026-10-30-windows-editor-surface-reuse.md](https://github.com/1lck/Lithe-IDEA/blob/main/.agents/notes/implemented/architecture/2026-10-30-windows-editor-surface-reuse.md) |
| Rust Core 边界 | [windows/README.md](https://github.com/1lck/Lithe-IDEA/blob/main/windows/README.md) |
| 声明式插件与信任分级 | [2026-10-12-declarative-language-plugins.md](https://github.com/1lck/Lithe-IDEA/blob/main/.agents/notes/implemented/architecture/2026-10-12-declarative-language-plugins.md) |
| 工程治理入口 | [AGENTS.md](https://github.com/1lck/Lithe-IDEA/blob/main/AGENTS.md) |
