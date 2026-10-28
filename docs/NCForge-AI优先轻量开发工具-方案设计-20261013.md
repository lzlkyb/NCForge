# NCForge（AI 优先的轻量开发工具）方案设计

> ⚠ 已过时（2026-10-27）：以 `NCForge-多期规划-方案设计-20261027.md` 为准。

> 日期：2026-10-13　状态：方案稿，待评审
> 已定决策：**自研（方案 B）**、**团队使用**、**驱动本机 Claude Code**（不自建 AI 客户端）

## 1. 背景与目标

NC65/NCC 二开目前依赖 Eclipse + UAP Studio：启动慢、吃内存；AI 改了文件 Eclipse 要手动刷新；编译错误、服务状态、日志都在 GUI 里，AI 看不到。

**目标**：做一个「AI 写、人审、一键跑」的 NC 专属工作台，替代日常 80% 的 Eclipse 使用场景。

**非目标**：
- 不和 VS Code/IDEA 拼通用编辑能力（重构、插件生态等）。
- 元数据（BMF）建模暂不替代，低频场景继续用 UAP Studio。

## 2. 现状摸底（本机实测 2026-10-13）

| 项 | 结果 | 对方案的影响 |
|---|---|---|
| NC65 home | `D:\NC65\nc65home`，modules/lib/external/framework 共 **3535 个 jar** | classpath 必须自动生成；jdt.ls 索引压力是头号风险 |
| NCC home | `D:\ncc\1909home` 也在本机 | 工作台要支持**多个 NC home / 多版本**切换 |
| 默认 JDK | NC 自带 ufjdk **1.7.0_51** | 编译目标是 1.7；jdt.ls 自身要 JDK 21 运行，需另带一个 JDK |
| 源码 | `C:\work\aier`（newar、EyePortal 等，SVN 管理，UTF-8/GBK 混合） | 编码保护是必做项 |
| Claude Code | 本机 2.1.296，Agent SDK 最新 0.3.296 | 可直接驱动；CLI 支持 stream-json 双向流和 `--resume` |
| 硬件 | 16G 内存、16 逻辑核 | 中间件 + 客户端 + jdt.ls 同时跑要控制内存 |
| Node | v24 | 前端构建可用 |

## 3. 定位与界面

```
┌──────────────────────────────────────────────────────────────────┐
│ NCForge  [NC65 ▾][newar ▾]  中间件 ●运行  库:aier0910(只读) [出补丁]│
├──────────┬──────────────────────────────────┬────────────────────┤
│ 任务/会话 │  改动审查 / 编辑器（Monaco）        │ Claude Code 对话    │
│ 文件树    │  diff：[接受] [拒绝] [我来改]       │ 工具调用卡片/权限确认│
├──────────┴──────────────────────────────────┴────────────────────┤
│ 编译 │ 日志(异常栈可点) │ 运行时变量(Arthas) │ SQL只读 │ 补丁清单      │
└──────────────────────────────────────────────────────────────────┘
```

NC 专属能力（工作台的价值所在）：
1. **补丁视图**：改动类、.class/.java 配对、SQL 是否带上，一键出包、提交 SVN（调用 nc-patch-pack）。
2. **表字段联动**：代码里的表名、字段悬停显示测试库真实结构和长度；出包前自动核对。
3. **异常栈直达**：日志异常点击跳到源码，或一键交给 AI 分析。
4. **运行时变量**：nc-debug 的 Arthas/hotlog 结果显示在代码旁。
5. **编码保护**：GBK/UTF-8 自动识别，原样保存。
6. **环境切换**：NC65/NCC home、测试库（含老测试库 aier0910）一键切换，数据库默认只读。

## 4. 总体架构

```
            ┌────────────── NCForge（Tauri 2 桌面程序）──────────────┐
            │ 前端：Monaco + monaco-languageclient + NC 面板           │
            │ 后端（Rust）：进程管理 / 文件监听 / 编码 / 会话管理       │
            └───┬──────────────┬────────────────────┬──────────────┘
                │              │                    │
         jdt.ls(JDK21)   Claude Code CLI       nc-core（CLI 引擎）
         补全/跳转/报错   stream-json 双向流     classpath│ecj编译│服务启停
                │        + nc-core 的 MCP        日志│补丁│DB只读│Arthas│SVN
                └──────────────┴────────────────────┘
                                │
                  NC home + C:\work\aier 源码 + 测试库
```

**原则**
- **nc-core 是唯一事实来源**：人点按钮和 AI 调 MCP 执行同一条命令，结果一致。
- **输出结构化**：编译错误、服务状态、异常栈都有 JSON 输出。
- **文件系统就是工作区**：没有 workspace 缓存，AI 改完即刻可见（文件监听）。
- **默认安全**：数据库只读；生产环境不可配置；危险操作走 Claude Code 自身的权限确认。

## 5. 关键设计

### 5.1 nc-core 引擎

| 命令 | 说明 |
|---|---|
| `nc env detect` | 自动发现 NC home、版本、JDK、源码模块；不写死任何路径 |
| `nc classpath` | 扫 NC home 生成 classpath（同时输出 jdt.ls 和 ecj 用的格式），按 jar 修改时间做缓存 |
| `nc build [--changed]` | ecj 增量编译（带 `-g`，目标 1.7），错误输出为 JSON |
| `nc server start/stop/status/log` | 中间件启停（含 JDWP 调试端口），日志实时跟踪 |
| `nc client` | 启动客户端 |
| `nc patch` / `nc svn` | 对接 nc-patch-pack |
| `nc db` | 对接 nc-db-query（只读） |
| `nc debug` | 对接 nc-debug（Arthas/hotlog） |
| `nc mcp` | 以上能力以 MCP 服务暴露给 Claude Code |

实现语言建议 **Java 或 Node**。Java 可直接调 ecj/SVNKit/JDBC，复用现有工具代码，倾向 Java（JDK 21 运行）。

### 5.2 驱动 Claude Code

- 工作台启动本机 `claude` 进程，用 **stream-json 双向流**通信（或用 Agent SDK 的 TS 封装，二者底层同一协议，P0 二选一实测）。
- **复用每个人现有的 Claude Code 配置**：登录、`~/.claude/skills`、CLAUDE.md、MCP 都照常生效，工作台只额外注入 nc-core 的 MCP。
- 会话用 `--resume` 恢复，和任务列表绑定（一个需求一个会话）。
- 权限确认在工作台里弹窗处理（使用 CLI 的权限提示转发机制，P0 实测具体参数）。
- 工具调用中的 Edit/Write 在中间栏渲染为 diff 卡片，供人审查。

### 5.3 Java 语言服务

- 内置 jdt.ls，单独附带 JDK 21 运行；项目运行时配置为 JavaSE-1.7 → ufjdk。
- classpath 由 nc-core 生成；把 3535 个 jar 中**不变的平台 jar** 与**二开模块**分开，减少重索引。
- 内存上限显式设定（初定 `-Xmx2g`），可在设置里调整。

### 5.4 团队化要求

| 方面 | 做法 |
|---|---|
| 安装 | 单个安装包，内含 JDK 21、jdt.ls、nc-core；Claude Code 单独安装（每人用自己的登录） |
| 更新 | Tauri updater 指向内网更新源（需一台内网静态服务器） |
| 零配置 | 首次启动自动探测 NC home、源码目录、SVN；探测不到再让用户选 |
| 团队 skills | NC 相关 skills（nc-patch-pack、nc-debug、nc-db-query、nc-async 等）放团队仓库，工作台负责同步到 `~/.claude/skills` |
| 数据库凭据 | 每人本地配置，不随安装包分发；默认只读账号 |
| 多版本 | NC65 与 NCC 同时支持，按项目切换 |

## 6. 技术选型

| 层 | 选型 | 备注 |
|---|---|---|
| 桌面外壳 | Tauri 2 | 复用 PastePanda 经验 |
| 编辑器 | Monaco | 自带 diff 视图 |
| 语言服务 | Eclipse jdt.ls | 通过 monaco-languageclient 接入 |
| 人工调试 | java-debug（DAP）走 JDWP | 放在最后一期 |
| AI | 本机 Claude Code（stream-json） | 已定 |
| 编译 | ecj | 与 Eclipse 产物一致 |

## 7. 分期计划

| 期 | 内容 | 估时 | 产出/验收 |
|---|---|---|---|
| **P0 验证** | ① jdt.ls 加载 NC65 的 3535 个 jar：首次索引时间、内存、补全延迟 ② stream-json 驱动 Claude Code：对话、权限转发、resume ③ Tauri 在本机能否正常构建运行 | 2–3 天 | 验证报告；任一项不通过则调整方案 |
| P1 引擎 | nc-core：env/classpath/build/server/log + MCP | 1–2 周 | AI 可完成「改→编译→重启→看日志」闭环 |
| P2 外壳 | Tauri + Monaco + 文件树 + 编码保护 + jdt.ls | 2 周 | 能打开项目、补全跳转、正确保存 GBK |
| P3 AI 集成 | Claude Code 对话面板、diff 审查、权限弹窗、会话/任务绑定 | 1–2 周 | 在工作台里完整走完一个需求 |
| P4 NC 面板 | 日志、补丁、表字段联动、DB 只读、Arthas | 1–2 周 | 出补丁和核表不再离开工作台 |
| P5 团队化 | 安装包、内网更新、skills 同步、首次引导 | 1 周 | 第二名同事零配置装好能用 |
| P6 调试 | DAP 断点/单步/变量 | 1–2 周 | 可选，之前过渡用 Eclipse/VS Code |

合计约 **8–11 周**（不含 P6 约 7–9 周）。建议 P5 完成后先找 1–2 名同事试用，再全员推广。

## 8. 风险

| 风险 | 等级 | 应对 |
|---|---|---|
| jdt.ls 在 3535 个 jar 下索引慢或内存爆 | 高 | P0 先验证；不行则降级为「ecj 报错 + 简单跳转」，放弃完整补全 |
| 16G 内存同时跑中间件、客户端、jdt.ls | 中 | jdt.ls 设上限；提供「轻量模式」（关闭语言服务） |
| Claude Code 版本升级导致协议变化 | 中 | 封装一层适配；锁定已验证的最低版本并检测 |
| 本机 Rust 构建坑（cargo 并行度过高会蓝屏、getrandom 0.3 触发 ProcessPrng 缺失） | 中 | 构建固定 `CARGO_BUILD_JOBS=2`；依赖审查时用 dumpbin 检查 |
| 维护成本落在少数人身上 | 中 | nc-core 与界面解耦，界面坏了 CLI/MCP 仍可用 |
| BMF 元数据建模 | 低 | 继续用 UAP Studio |

## 9. 待确认

1. 团队规模、同事机器配置是否接近（内存、NC 版本）。
2. 内网有没有可用作更新源的静态服务器。
3. 同事是否都已有 Claude Code 账号。
4. 团队 skills 仓库放 SVN 还是 Git。
