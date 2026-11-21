# GitHub 调研：还有没有别的加速方案（2026-11-21）

> 问题：`docs/NCForge-智能代码-单索引常驻-规划-2026-11-21.md` 的 S0 实测已经把两条路堵死 ——
> flat 冷导入 154~355s，**warm 与 cold 相同**（354.7 → 359.1s）。
> 所以「预建索引 / 二次打开」不成立。本文回答：**外部还有没有第三条路**。
>
> 结论先说：**把能查到的候选逐个落地验证了一遍，没有一条能替掉「一次导入 + 常驻」。**
> 其中看起来最诱人的一条（jdt.ls 语法服务器）已经用**源码 + 实测**双重否掉，
> 这一条否定的价值最大 —— 它本来会是 S4 双阶段的 Phase 1。

## 1. 判定总表

| # | 方案 | 出处 | 判定 | 判据 |
|---|---|---|---|---|
| 1 | **语法服务器**（`-Dsyntaxserver=true`，vscode-java `Hybrid` 的轻量阶段） | jdt.ls v0.57.0 `SyntaxProjectsManager` | ❌ **不能用于跳转** | `importProjects` 是**空实现**；实测 6.2s 就绪但 `documentSymbol → []`、`definition → []` |
| 2 | **共享索引** `-Djdt.core.sharedIndexLocation=<dir>` | eclipse.jdt.ls #1890、#1127、#2341 | ⚠️ **当前版本不支持，且收益对不上瓶颈** | #2341 于 2023-01 合入；我们捆绑的是 0.57.0（2020-06）。且它只共享**库 jar** 的索引 |
| 3 | 关掉 importer（`java.import.gradle/maven.enabled=false`、`autobuild.enabled=false`、`maxConcurrentBuilds`） | vscode-java 文档、jdt.ls #2519 | ✅ 早已做到 | 我们本来就用自制 `.classpath`，不经 maven/gradle；`autobuild` 已关（影子工程只有 javabuilder） |
| 4 | AppCDS（`-XX:+AutoCreateSharedArchive`） | vscode-java `java.jdt.ls.appcds.enabled` | ⏸ 可选，收益秒级 | 省的是 JVM/OSGi 引导，不缩短 import |
| 5 | JVM 调优（G1GC、`-Xmx`、`UseStringDeduplication`） | vscode-java-pack #1463 的建议 | ⏸ 可选 | warm 实测峰值 296MB，**内存不是瓶颈**；#3421 里官方也承认索引只用 ~5% CPU，单线程瓶颈加核无效 |
| 6 | **javac 插件式离线索引**（scip-java / semanticdb-javac） | sourcegraph/scip-java | 🔶 远期备选 | 跳转查表、精度高；但要求**全量 javac 可编译**，NC 走 ECJ，风险高 |
| 7 | 轻量自建索引（tree-sitter / javaparser 符号求解） | — | ❌ 不建议 | 重载/继承/泛型都解不准；等于自养一套类型系统 |

## 2. 最该记住的否定：语法服务器（实测 + 源码）

这条本来是最优候选：vscode-java 默认 `Hybrid` 就是「先起语法服务器（`ss_ws`）、标准服务器就绪后接管」，
官方文档写它支持 "navigating among source code and JDK"。如果它成立，S4 的 Phase 1 就是现成的。

**先确认它存在**（不用升级）：反编译捆绑的 `org.eclipse.jdt.ls.core_0.57.0.202006172108.jar`，
`org/eclipse/jdt/ls/core/internal/syntaxserver/` 下有 `SyntaxLanguageServer`、`SyntaxProjectsManager`、
`SyntaxInitHandler`；`SyntaxLanguageServer` 注册了 `textDocument/definition`、`typeDefinition`、`hover`、
`documentSymbol`、`completion`、`foldingRange`、`selectionRange`。开关是系统属性 `syntaxserver`
（`JDTEnvironmentUtils` 读的字面量），即 `-Dsyntaxserver=true`，**必须放在 `-jar` 之前**。

**实测（`tests/syntax_probe.rs`，6 个模块 / 3086 个源文件，无 jar 的 flat 影子）：**

| 项 | 实测 |
|---|---|
| initialize 返回 | **3.1s** |
| ServiceReady | **6.2s**（注意：消息是 `LightWeightServiceReady`，`type` 不是 `ServiceReady`，按 type 判会一直以为没好） |
| `textDocument/documentSymbol` | **`[]`** ← 文件根本没被解析 |
| `textDocument/definition`（跨模块 import） | 300s 内始终 **`无目标：[]`** |

**源码给了解释**（`v0.57.0` 的 `SyntaxProjectsManager`）：

```java
@Override
protected void importProjects(Collection<IPath> rootPaths, IProgressMonitor monitor)
        throws CoreException, OperationCanceledException {
    // do nothing at syntax server mode.
}
```

**语法服务器压根不导入工程** —— 我们的 `.project`/`.classpath`、223 个源根全被无视，
文件不在任何 Java project 里，于是只有「单个打开的文件」这一层语法解析，跨文件、跨源根一概没有。
JDK 类能跳是因为 JRE 容器自带源码，与工程导入无关 —— 官方文档那句 "navigating among source code and JDK"，
在 LightWeight 下实际指的是「当前文件 ↔ JDK」。

> **对规划的影响**：S4 的 Phase 1 **必须用 single 语义实例**（46s → 只服务当前模块），
> 不能用语法实例。语法实例唯一的价值是「3~6 秒就有高亮/大纲/折叠」，
> 但那 40 秒差距不值得多养一个进程，**不立项**。

## 3. 共享索引为什么救不了我们

`-Djdt.core.sharedIndexLocation=<dir>` 是 JDT 侧已有的能力，jdt.ls 通过它把索引放到公共目录：

- 合入时间：eclipse.jdt.ls **#2341（2023-01）**；vscode-java 把它暴露为 `java.sharedIndexes.enabled/location`，
  Windows 默认 `%APPDATA%\.jdt\index`；
- 作用域：**库（jar）的索引**跨 workspace 复用，不涉及工程源码；
- 我们捆绑的是 **0.57.0.202006172108（2020-06）**，早于该能力两年半，**参数无效**。

即便升级到 1.x 能拿到，它也对不上瓶颈：我们做过 warm 实测 —— **同一个 data 目录**第二次导入，
耗时 359.1s（cold 354.7s），只有峰值内存从 973MB 降到 296MB。也就是说
**索引确实被复用了，但时间一点没省** ⇒ 时间花在 import/build 阶段的源文件解析与编译单元建模，
不在 index 构建。共享 jar 索引能省的是后者。

**所以「为 sharedIndexLocation 升级 jdt.ls」不成立**：升级还要 JDK 17/21 运行（我们用的是 NC 自带 JDK 8），
回归面覆盖整个代码智能，收益却落在不是瓶颈的那一段。

## 4. 真正有效的是三件事（都在既有规划里）

1. **一次导入 + 常驻不重启**（S3）—— 这是唯一能把「每个模块都要等」变成「一天等一次」的手段。
   行业同构：IDEA 首次索引同样要几分钟，之后靠增量；Eclipse 也一样。**没有哪家 IDE 能做到冷启动即全量可跳**。
2. **classpath 缓存**（S1）—— `select_jars` 95s 只在 classpath 变化时付一次。
3. **后台预热** —— 打开工作区就在后台起 flat 实例，不要等用户点开第一个 `.java`。
   用户「看文件」的时间天然覆盖了大部分导入时间。

## 5. 若还要继续压时间：两个成本可控的实验（未做）

| 实验 | 做法 | 预期 | 风险 |
|---|---|---|---|
| **减 jar** | flat 下把「类集合已被工程源码全覆盖」的模块 jar 剔出 classpath（判据：jar 的类集合 ⊆ 源码类全集，`ClassIndex` 已有 jar 侧数据，源码侧需扫 7419 个文件的 package/class） | 1162 → 估计 400~600 条，导入时间降 20~40%（**未量**） | 判错会漏类；必须先量「154~355s 里 jar 索引 vs 源码解析各占多少」，否则可能白改 |
| **懒加载式 flat** | 先只链当前模块 + 常用模块，跳不到时再扩链并 re-import | 首屏 46s 级 | re-import 会打断，体验比「后台预热」更差，优先级低 |

## 6. 远期：javac 插件式离线索引（scip-java）

`sourcegraph/scip-java`（原 lsif-java）用 `semanticdb-javac` 挂在 javac 的 `ANALYZE` 阶段，
**每个 `.java` 生成一个 `.semanticdb`**，再合成 `index.scip`；跳转/引用/实现都是查表，不需要常驻服务。
Sourcegraph 的定位就是「精确代码导航，不依赖语言服务器」。

为什么现在不做：

- 我们是 **ECJ** 编译（`ecj_worker.rs`），`semanticdb-javac` 是 `com.sun.source.util.Plugin`，**ECJ 不兼容**；
  走 javac 就要全量可编译 —— NC 工程带私有 jar、历史代码，全量编译本身可能失败；
- 编译失败的编译单元没有索引 ⇒ 恰好是最难解析的那部分代码跳不了；
- 索引要与工作副本同步（SVN 更新后增量重编），等于再养一条编译链路。

**触发重开的条件**：将来若把编译主链切到 javac（或 ECJ 出了等价的插件机制），这条能一步跨过 jdt.ls 的冷启动。

## 7. 复现

```bash
# 语法服务器探针（约 5 分钟；结论落 desktop/target/perf/syntax-probe.md）
cd desktop/src-tauri
NCFORGE_SCALE_MODULES=6 cargo test --test syntax_probe -- --ignored --nocapture
```

`tests/syntax_probe.rs` 会先在工作区里找一处**真实的跨模块 import**（目标 `.java` 必须存在于另一个已链模块的
源根下），再起语法服务器、轮询 `definition`，并同时打一发 `documentSymbol` 区分
「服务端不响应」与「响应了但解析不到」。

## 8. 引用

- eclipse-jdtls/eclipse.jdt.ls **#1890**（headless 预建索引 / `sharedIndexLocation` 用法）
- eclipse-jdtls/eclipse.jdt.ls **#1127**（`.metadata` 膨胀 → 指向共享索引；2023-01 标注 #2341 已实现）
- eclipse-jdtls/eclipse.jdt.ls **#3421**（大工程索引慢；官方回复只有 `sharedIndexLocation` 一个优化项）
- eclipse-jdtls/eclipse.jdt.ls **#2519**（build job 影响响应性）、**#3510**（延迟三个 handler，首导省 ~10%）
- microsoft/vscode-java-pack **#1463**（首导/二导性能清单）
- redhat-developer/vscode-java `javaServerStarter.ts`（`-Djdt.core.sharedIndexLocation`、AppCDS、`syntaxserver` 的客户端侧）
- code.visualstudio.com `java/java-project`（LightWeight 能力边界：「不解析依赖、不 build」）
- sourcegraph/scip-java `docs/design.md`（javac 插件 → SemanticDB → SCIP）
