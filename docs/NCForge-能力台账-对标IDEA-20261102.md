# NCForge 能力台账：对标 IntelliJ IDEA（⚠️ 已停用，2026-11-15）

> 🔴 **本文不再是「唯一入口」，不要据此排期。** 2026-11-15 逐条 grep 复核发现
> **§2 的 3 条缺口全部已实现、§4「不做」表至少 6 条已实现**（明细见下方 §0）。
> 原文保留作历史快照，**新结论一律看**：
> - 代码编辑能力：[`NCForge-代码编辑能力-对标与超越方案-2026-11-15.md`](./NCForge-代码编辑能力-对标与超越方案-2026-11-15.md)
>   + 实测落地 [`NCForge-代码编辑-6条落地-2026-11-15.md`](./NCForge-代码编辑-6条落地-2026-11-15.md)
> - 数据库能力：[`NCForge-数据库行业差距终版台账-2026-11-10.md`](./NCForge-数据库行业差距终版台账-2026-11-10.md)
>   + [`NCForge-数据库能力边界决策-2026-11-10.md`](./NCForge-数据库能力边界决策-2026-11-10.md)（2026-11-10 拍板，仍生效）
>
> 日期：2026-11-02（同日裁剪低 ROI 项）
> 原用途：只记仍未闭合的能力缺口。**该定位已于 2026-11-15 废止。**
> 历史审计（含已关闭项、技术依据与验收记录）见
> [`NCForge-对标IDEA-能力缺口-20261101.md`](./NCForge-对标IDEA-能力缺口-20261101.md)；
> 本文不复制它的逐条矩阵，只保留当时状态。
>
> 维护规则：
> 1. 每条状态必须能指到代码。写「有」就要给出文件与行；写「缺」要先 grep 证明全仓无实现。
> 2. 关闭一条 = 从本文删除，并在 `CHANGELOG.md` 写清落点与验收方式。
> 3. 新排期项必须带编号（P1-x / P2-x，对应任务清单），否则不进迭代。
> 4. 本文与代码冲突时以代码为准，先改本文再排期。
> 5. **进「不做」不等于永远不做**：写下触发条件，真出现诉求再从 §4 捞回来。

## 0. 2026-11-15 复核：本文哪些判定已经错了

复核方法就是本文 §6 那三条命令（先 grep 证明有没有）。**结论：本文已不可信，逐条如下。**

| 本文原判定 | 实际现状（2026-11-15 grep 核实） | 代码证据 |
|---|---|---|
| §2.1 新建 Java 类文件模板「**缺**」 | **已实现** | `src-tauri/src/file_template.rs`（`lib.rs:71` 已注册）+「新建 Java 类型…」对话框 |
| §2.1 格式化「**待实测**」、服务端「刻意关掉」 | **已开且实测有效** | `lsp.rs:304` 现为 `"format": { "enabled": true }`（`7302837`，2026-11-15 打开）；`textDocument/formatting` 实测回 **18 处 TextEdit**，`rangeFormatting` 9 处 |
| §2.1 提取参数「**缺**」 | **已实现（受限版）** | `src/lib/refactorParameter.ts` + `refactorWorkbench`；默认窄档，设置里有宽档开关 |
| §4 保存时自动格式化「服务端 format 已刻意关」 | **前提已不成立** | 同上，服务端已开；**默认关的理由仍成立**（NC 是 CRLF + Tab，默认开会改脏文件），但别再写「服务端关着」 |
| §4 移动类 / 改签名 / 内联重构「**不做**」 | **已实现** | `src/lib/refactorMenu.ts:62-63`（inlineVariable / inlineMethod）、`RefactorWorkbenchHost.tsx:30`（signature / moveType / renamePackage / visibility） |
| §4 结构化搜索替换 SSR「**不做**」 | **已实现** | `RefactorWorkbenchHost.tsx:30,59-65`：`ncforge.structuralSearch`，`$变量$` 捕获 + 替换预览 |
| §4 Inspect Code 批量检查「**不做**」 | **已实现** | 同上：`ncforge.batchInspect`，范围可选当前文件 / 整模块，含批量整理导入 |
| §4 Inlay Hints「0.57 无 handler，**不做**」 | **已自研实现** | `src/lib/javaParameterHints.ts:49` 真注册了 `registerInlayHintsProvider`，参数名 + 推断类型两种；**不依赖 jdt.ls 的 inlayHint handler** |
| §4 jar / 依赖内文本搜索「**不做**」 | **已实现** | `src-tauri/src/jar_symbols.rs`、`java_comments.rs`（class 常量池 + `_src.jar` 内 `.java` 注释可搜可打开） |
| §4 抑制警告管理「不做」 | **不做，且已证实做不到** | jdt.ls 0.57 **不下发** `@SuppressWarnings` quick fix：6 类问题逐条问 codeAction，35 个动作 **0 条**含 suppress。`SuppressWarningsProposal` 在 `org.eclipse.jdt.ui`，jdt.ls 不加载 |

**仅两条「不做」经复核仍然成立**：CodeLens（客户端没声明、前端无 provider）、Profiler / UML / HTTP Client（与 NC 二开无关）。

🔴 **方法论教训**：本文 §6 写了复核方法，但**没有人定期跑它**。「不做」表尤其危险——它会让后来人（包括 AI）跳过 grep 直接下结论，把已经做完的事再立项一遍。**判「缺 / 不做」之前必须当场 grep，不能引用任何台账。**

## 状态口径

- **有**：主路径能用，且代码可指认。
- **部分**：有实现但能力受限（明确写出限制）。
- **缺**：全仓无可用实现。
- **待实测**：代码存在但真实效果未验收；不许当「有」排期。
- **不做**：明确取舍，附理由与触发条件；列入 §4。

复杂度是「熟悉本仓的人」的实现成本，不是价值：
**1** 几小时；**2** 一两天；**3** 一周；**4** 数周；**5** 数月/新子系统。

## 1. 已对齐基线（不再逐条跟踪）

以下能力已与 IDEA 日常工作流对齐，代码证据见 2026-11-01 审计 §1 与 §7：
补全/悬停/参数提示/跳定义/找引用、重命名（预览 + 跨文件）、提取四件（变量/常量/字段/方法）、
安全删除、实时诊断 + 问题面板、快速修复、组织导入、
代码生成（构造器/getter/setter/toString/equals/hashCode）、override/implement、
Live Templates、Error Lens、语义高亮、调用层级、类型层级（自研 bundle）、
折叠/当前符号高亮/扩展选区、全工程搜索替换、TODO、书签、本地历史、文件监听、
多工程依赖链、编译当前模块与全部模块、调试器（DAP + java-debug）、
SVN 全套（含 annotate 与已审标记）、数据库工具窗、编码/换行无损处理。

## 2. 未闭合缺口

### 2.1 编辑辅助与重构

| 缺口 | 现状 | 证据 / 限制 | 复杂度 | 去向 |
|---|---|---|---|---|
| ~~新建 Java 类的文件模板（package / 版权头）~~ | ~~缺~~ → **已实现，见 §0** | ~~新建走空文件；无 `fileTemplate` 概念~~ 现为 `src-tauri/src/file_template.rs` | 1 | 已闭合 |
| ~~格式化实际可用性~~ | ~~待实测~~ → **已实测有效，见 §0** | ~~服务端 `java.format.enabled` 被刻意关掉（`lsp.rs:282`）~~ 现 `lsp.rs:304` = `true`，实测 18 处 TextEdit | 1 | 已闭合 |
| ~~提取参数~~ | ~~缺~~ → **已实现（受限版），见 §0** | ~~0.57 的 `java/getRefactorEdit` 没有 extract parameter~~ 现为 `src/lib/refactorParameter.ts` | 2 | 已闭合 |

### 2.2 版本控制

| 缺口 | 现状 | 证据 / 限制 | 复杂度 | 去向 |
|---|---|---|---|---|
| 提交前检查串联 | **部分** | 补丁页有表结构核对，但与 SVN 提交动作未串成「提交前必须通过」 | 2 | 未排期 |

> 其余对标项（运行测试、批量检查、Change List / Shelve、编辑便利类）见 §4，已判不做。

## 3. 原审计中已过期、本次核对修正的判定

这些条目在 2026-11-01 审计里标「缺/部分」，但代码已经落地，后续排期不要再算进去：

| 原判定 | 实际现状 | 证据 |
|---|---|---|
| 编译全部模块「缺」 | **有**：按依赖顺序编译全部模块（可取消、问题汇总） | `src/lib/compile.ts:51`、`src/hooks/useModuleCompile.ts:144`、`src-tauri/src/commands/compile_cmds.rs:290` |
| 分屏编辑「缺」 | **有**：右侧分屏，标签右键「在右侧打开 / 关闭分屏」，会话可恢复 | `src/hooks/useSplitView.ts:9`、`src/components/workspace/FilePaneSlots.tsx:117`、`src/components/workspace/TabStrip.tsx:126-130` |
| 保存时动作「缺」 | **部分**：`formatOnSave` 偏好 + 保存前调用已接，默认关；真实效果见 §2.1「格式化实际可用性」 | `src/lib/formatOnSave.ts:20`、`src/components/settings/EditorSettings.tsx:96` |
| 自动保存「缺」 | **有**：偏好可开，默认关（NC 常「改一半就编译」） | `src/lib/editorPrefs.ts:43`、`src/components/workspace/EditorPane.tsx:197-201` |
| 文件监听「缺」 | **有**：`notify` 递归监听、合并刷新，只刷树不碰编辑器 | `src-tauri/src/watcher.rs:26` |

> 注意：上表只修正状态，不改变原审计里的技术依据。落地细节与验收记录仍看 2026-11-01 文档 §7。

## 4. 明确不做（含 2026-11-02 裁剪）

「触发条件」是重新评估的最低门槛；没有触发条件就不排期。

| 项 | 理由 | 触发条件 |
|---|---|---|
| Profiler / 覆盖率 / 依赖 UML 图 | 与 NC 二开场景无关，维护成本高 | 无 |
| ~~结构化搜索替换（SSR）~~ | ⚠️ **已实现，见 §0**（`ncforge.structuralSearch`，`$变量$` 捕获 + 替换预览） | — |
| HTTP Client | NC 前端是 JSP/upm，不走这个路径 | 无 |
| 源码根 / 排除目录 UI | `.classpath` 是唯一真源，UI 再改一套会漂移 | 无 |
| 任意多 root | 工程模型是「主工程 + 依赖闭包」，任意 root 会破坏类路径真源 | 工程模型本身要改 |
| 保存时自动格式化（默认开） | NC 代码是 CRLF + Tab，默认开会大面积改脏文件。⚠️ **原文「服务端 format 已刻意关」已不成立**（`lsp.rs:304` 现为 `true`，见 §0）；不做的是「默认开」，不是「格式化」 | 无 |
| ~~移动类 / 改签名 / 内联重构~~ | ⚠️ **已实现，见 §0**（`refactorMenu.ts:62-63`、`RefactorWorkbenchHost.tsx:30`）。原理由「0.57 无内联处理器」只对服务端成立，我们自研了 | — |
| 运行单个类 / JUnit 单测运行 | NC 二开不靠本地 runner 验证，编译 + 部署 + 服务日志是主链路 | 团队开始维护本地单测 |
| ~~Inspect Code 批量检查~~ / 自定义检查规则 / 抑制警告管理 | ⚠️ **批量检查已实现**（`ncforge.batchInspect`，见 §0）。**抑制警告仍不做且已证实做不到**：jdt.ls 0.57 的 35 个 codeAction 里 0 条含 suppress | 自定义规则：出现明确诉求 |
| ~~Inlay Hints~~ | ⚠️ **已自研实现，见 §0**（`javaParameterHints.ts:49`）。原理由「0.57 无 handler」只对服务端成立，我们没走服务端 | — |
| CodeLens | 客户端没声明、前端无 provider；NC 工作流没有对应的操作入口 | 出现具体可挂载的 CodeLens 动作 |
| Change List / Shelve / 与剪贴板比较 | 版本控制以「补丁打包 + 评审」为中心，不是 IDEA 的变更集工作流 | 团队改用变更集式提交 |
| ~~jar / 依赖内文本搜索~~ | ⚠️ **已实现，见 §0**（`jar_symbols.rs` class 常量池 + `java_comments.rs`，`_src.jar` 内注释可搜可打开）。触发条件「出现跨 jar 文本排查需求」确已出现 | — |
| 后缀补全 / 粘贴自动 import / 复制剪切类 / 彩虹括号 | 纯敲键便利，维护面不小，与 NC 主业价值不匹配 | 用户明确提出 |

## 5. 保留排期（非 IDEA 对标项）

来自同架构轻量 IDE 调研，经 2026-11-02 裁剪后只剩两条：

| 编号 | 项 | 为什么保留 | 复杂度 |
|---|---|---|---|
| P1-10 | 安全纵深补齐 | 新写路径与外部控制的地基，也保护现有 141 条命令 | 4，分阶段 |
| P2-12 | Testbook 式横切测试矩阵 | 防 UI 改版漏入口；在安全改动定型后锁回归 | 3 |

已裁剪（不进任务清单）：

| 原编号 | 项 | 裁剪理由 | 重新考虑的条件 |
|---|---|---|---|
| P1-8 | 集成终端（PTY + xterm.js） | ConPTY 长驻子进程维护成本高，对 NC 日常链路增益最小；系统终端已够用 | 需要把终端状态纳入工作台会话/自动化 |
| P1-9 | CLI / MCP 控制面 | 目前没有 AI 或外部脚本消费者，先建协议等于维护空接口 | 真正接入 AI 助手或外部流水线驱动 |
| P2-11 | 编辑器主题独立 + 主题导入 | 现有主题 + token 已够用；导入 VS Code 主题属装饰性需求 | 有用户明确要求导入外部主题 |
| P2-13 | 补丁评审持久评论 | 单人开发、当天审完当天提交；现有「已审标记 + 本地历史 + CHANGES.md」已覆盖 | 出现跨人复核或隔天续审的场景 |
| P2-14 | 企业托管模式 | 没有部署方与客户诉求，容易做成死配置 | 出现企业统一配置下发需求 |

## 6. 复核方法

```bash
# 缺什么：先证明全仓没有
grep -rn "关键词" desktop/src desktop/src-tauri/src --include=*.ts --include=*.tsx --include=*.rs

# 有什么：命令契约保证「前端调用的命令」都真实登记
cd desktop && npm run contract:check

# 孤立实现：删了调用方却忘了删实现，会在这里红
cd desktop && npm run orphans:check
```

本文的「缺」全部按上述方法复核过；「有」必须带文件行号，改代码后行号漂移时以符号名为准。
