# jdt.ls 升级能否解决「切模块要等」——可行性核算

> 2026-11-21。问题：把捆绑的 jdt.ls 0.57.0（2020-06）升到当前 1.63.0，能否解决
> 「每次切模块都要等 3~6 分钟」。
>
> **结论：不能。核心痛点的成因不在 jdt.ls 版本上，升级的净收益接近零，
> 代价是 ~300MB 安装包增量 + 一轮全量功能回归。**

## 1. 先划清痛点的归属

我们实测的 154~355s 拆开是三段，升级只能影响第三段：

| 阶段 | 耗时 | 归属 | 升级能改变吗 |
|---|---|---|---|
| `select_jars` 精选 jar | 95s | **我们自己的 Rust 代码** | ❌ 完全无关 |
| ClassIndex 构建 | 63s | **我们自己的 Rust 代码** | ❌ 完全无关 |
| jdt.ls 导入 + build workspace | 129~355s | jdt.ls / JDT core | ⚠️ 唯一可能 |

即使第三段归零，也还剩 158s。**升级的天花板只有一部分。**

## 2. 三条硬约束（决定了升级不是「换个 jar」）

### 2.1 运行时 JDK：必须额外捆一个 21/25

| jdt.ls 版本 | 运行所需 JDK |
|---|---|
| 0.57.0（当前） | Java 8（NC ufjdk 1.8.0_202 可跑，已实测） |
| v1.30.x（2025-01 前） | Java 17 |
| **v1.31.0 起** | **Java 21** |
| **main / v1.63.0** | **Java 25** |

用户明确**只用 1909home 的 1.8.0_202**。所以升级 = 安装包里必须再带一套 JDK 21/25
（Temurin JRE 解压约 180MB），jdt.ls 用它跑、项目源码仍按 1.8 编译。这在技术上完全可行
（VS Code 的 `java.jdt.ls.java.home` 就是这个模式），但**体积代价实打实**。

### 2.2 启动参数必须补模块化开关

JDK 9+ 下 jdt.ls 起不来，除非加：

```
--add-modules=ALL-SYSTEM
--add-opens java.base/java.util=ALL-UNNAMED
--add-opens java.base/java.lang=ALL-UNNAMED
```

当前 `JdtlsLaunch::command()` 没有这几个参数（1.8 不需要）。这属于「升级时必须一起改，
忘了就启动即失败」的隐性坑。

### 2.3 我们自己的扩展 bundle 要重编

`resources/jdtls-ext/ncforge-jdt-ext.jar`：

```
Require-Bundle: org.eclipse.jdt.core, org.eclipse.jdt.ls.core, org.eclipse.lsp4j, ...
Bundle-RequiredExecutionEnvironment: JavaSE-1.8
```

用的是 `Require-Bundle` 且**无版本区间**，靠的是 jdt.ls **内部 API**（类型层级功能）。
0.57 → 1.63 跨度 6 年，内部包结构有变动，必须重编 + 逐个功能验证。
同理 `resources/jdtls/java-debug/com.microsoft.java.debug.plugin-0.32.0.jar`（2020 年）
也要跟着升，DAP 链路（我们的 `dap.rs`）需要适配。

### 2.4 源码级别：这一关过得去

影子工程写的是 `JRE_CONTAINER/.../JavaSE-1.8`，高版本 README 明确
"Supports compiling projects from Java **1.8** through 25"，正好卡在下限。
NC65 若需 1.7，1.8 是 1.7 语法超集（`_` 在 1.8 仍是合法标识符），解析层面无风险。

## 3. 逐项收益核算

### 3.1 语法服务器：**升级后依然不导入工程（源码级确认）**

main 分支 `SyntaxProjectsManager.java`（v1.63）原文，一字未改：

```java
@Override
protected void importProjects(Collection<IPath> rootPaths, IProgressMonitor monitor)
        throws CoreException, OperationCanceledException {
    // do nothing at syntax server mode.
}
```

我们从 0.57 的 jar 里解出同名方法，也是同一句。**这条路在最新版依然封死。**
实测（`tests/syntax_probe.rs`，6 模块 3086 文件）：6.2s 就绪，`documentSymbol → []`，
跨模块 `definition` 300s 恒 `无目标：[]`。

### 3.2 索引并行：**官方明确没有**

jdt.ls #3421（AOSP 几十万文件索引慢）里维护者 rgrunber 回复：

> "Currently the only improvement we offer is ... `-Djdt.core.sharedIndexLocation`"

同帖用户实测：**i9-13900 + 64GB，索引只用到 5% CPU** —— 即 JDT 索引基本单线程。
官方没有「多线程索引」这条路径，升级也拿不到。

### 3.3 共享索引 `sharedIndexLocation`：**不对症**

- 1.19.0 才有（我们 0.57 没有），升级可拿到
- 但它**只共享库 jar 的索引**，不含源码工程
- 我们 warm 实测（同一 data 目录导入两次）已证明：**冷 354.7s → 热 359.1s，
  缓存命中但不省时**。瓶颈不在库索引重建

### 3.4 CHANGELOG 里 18 条 `performance`：**没有一条是数量级**

逐条看最相关的：

| 版本 | 条目 | 对我们是 |
|---|---|---|
| 1.21.0 | postpone autobuild 以**提前宣告可用**（#2527） | 只是状态栏早点绿；跳转仍需 build 完 |
| 1.50.0 | 推迟注册 resource/element 监听（#3510） | 官方说省 **~10%** |
| 1.61.0 | Maven/Gradle 导入时批量序列化 DigestStore | 我们**不用 Maven/Gradle** |
| 1.53.0 / 1.36.0 / 1.30.1 / 1.22.0 | 全是 Maven / Gradle 导入优化 | 同上，**零收益** |

我们走自制 `.classpath`，18 条里过半是 Maven/Gradle 专属。**能命中的全是 10% 量级。**

### 3.5 JVM 换代本身（G1/ZGC/CDS）

JDK 8 → 21 的 GC 与类加载确实更好，但这一段的绝对量级是「秒到几十秒」，
面对 129~355s 的导入不改变结论；且 JVM 换代同时**增加**启动时的模块化开销。

## 4. 成本清单（升级要付的）

| 项 | 量 | 说明 |
|---|---|---|
| 安装包增量 | **+180~250MB** | 额外 JDK 21/25 |
| jdt.ls 分发件 | ~90MB | 替换现有 0.57 |
| 扩展 bundle 重编 | 1 个 jar | 内部 API 跨 6 年，需逐个功能验证 |
| java-debug 升级 | 1 个 jar | DAP 链路适配 |
| LSP 客户端能力 | `extendedClientCapabilities` 一批 | 缺失会静默降级（`classFileContentsSupport` 等） |
| 启动参数 | `--add-modules` / `--add-opens` | 漏了直接起不来 |
| 回归面 | 跳转/补全/诊断/重构/DAP/类型层级/热替换 | 全量 |

## 5. 结论与判据

**不要升。** 核心痛点（切模块等 3~6 分钟）的成因是「切模块 = 杀进程重启」，
这是**我们自己的生命周期设计**（`lang_cmds.rs` 按模块 `lang_start`），
不是 jdt.ls 版本问题。升级不碰这条链路分毫。

唯一有效的手段仍是既有的 **S3：一次导入 + 常驻不重启**——把「每个模块都等」
变成「一天等一次」。IDEA/Eclipse 冷启动同样要几分钟，行业里没有「冷启动即全量可跳」。

**重新评估触发的两个条件**（写死，别凭印象）：

1. jdt.ls 官方实现「语法服务器导入工程」**或**「并行索引」——盯
   `SyntaxProjectsManager.importProjects` 与 #3421、#2519
2. 我们自己的 95s + 63s 两段被消掉之后，第三段成了唯一大头（那时升级的
   相对价值才会浮上来）

**顺带记一条正面发现**：高版本 1.21+ 自带「postpone autobuild 提前宣告可用」，
与我们 S4 双阶段思路一致，可作为 S4 实现方式的参考（但**不能替代**，
因为它只提前状态，不提前可跳转能力）。

## 6. 复现命令

```bash
# 确认绑定版本的语法服务器仍是 no-op（v1.63 = main）
curl -s https://raw.githubusercontent.com/eclipse-jdtls/eclipse.jdt.ls/main/\
org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/syntaxserver/\
SyntaxProjectsManager.java | grep -A2 "protected void importProjects"

# 确认运行时 JDK 下限
curl -s https://raw.githubusercontent.com/eclipse-jdtls/eclipse.jdt.ls/main/README.md \
  | grep -i "runtime environment"

# 我们捆绑版本的同类证据（本地）
unzip -p resources/jdtls/plugins/org.eclipse.jdt.ls.core_0.57.0.*.jar \
  org/eclipse/jdt/ls/core/internal/syntaxserver/SyntaxProjectsManager.class \
  | grep -ac "do nothing"
```
