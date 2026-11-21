# jdt.ls 的替代品 —— GitHub 调研

> 2026-11-21。问题：有没有能替代 jdt.ls 的东西。
>
> **结论分两层：**
> **① 整体替代（跳转+补全+诊断+重构+调试）—— 没有。**
> **② 按层替代（只换「索引 + 跳转」这一层）—— 有三个真候选，架构正好对准我们的痛点。**
>
> 正确的做法不是「换掉 jdt.ls」，而是**快慢双通道**：声明索引做快通道（25s 级），
> jdt.ls 退到慢通道管诊断/重构/调试。这正是 S4 双阶段的强化版。

## 1. 为什么不能整体替换

jdt.ls 提供给我们的能力是四类，候选方案只覆盖前两类：

| 能力 | 我们在用 | 候选覆盖 |
|---|---|---|
| 跳转 / 引用 / 类型层级 | ✅ `definition`、`ncforge.typeHierarchy` | ✅ 候选都有 |
| 补全 | ✅ `completion` | ⚠️ 粗糙或没有 |
| 诊断（红波浪线） | ✅ `publishDiagnostics` | ⚠️ 部分有 |
| 重构（重命名/提取变量/组织导入） | ✅ `rename`、`codeAction` | ❌ 基本没有 |
| 调试（DAP） | ✅ `java-debug` | ❌ 没有 |
| 扩展 bundle（`ncforge-jdt-ext`） | ✅ 类型层级 | ❌ 无扩展 API |

**没有第二个 Java 语言服务器提供完整这四类。** IntelliJ Platform 有这个能力，但它没有可产品化的
headless LSP server（`lsp-api` 是给插件用的，不是对外服务），且运行时是 GB 级。

## 2. 三个真候选

### 2.1 Metals v2（最成熟，Apache-2.0）

- 仓库：`scalameta/metals` 分支 **`main-v2`**，版本 **2.0.0-M2**
- 站点：https://metals-lsp.org/
- 背书：Databricks 开源，Cursor 在用；2346 star（仓库整体）
- 架构：**索引源码，绕过 build**。Java 侧用 **Turbine**（Google 的 header compiler）
  抽类型信息，不做完整编译
- 实测（官方）：**~100 万行/秒**，1000 万行代码库 **10~20s** 可用
- 能力（Java 列）：Diagnostics、Go to definition、Find references、Find implementations ✅
- **缺**：重构未实现；Code Action 只有 import 建议；第三方依赖要手写 `.metals/mbt.json`

`mbt.json` 形状对我们**极其有利** —— 我们本来就有完整 classpath：

```json
{ "dependencyModules": [
    { "id": "com.google.guava:guava:33.5.0-jre",
      "jar": "/path/to/guava.jar", "sources": "/path/to/guava-sources.jar" } ] }
```

我们 1162 个 jar 的绝对路径 + 部分 sources jar（`classpath_sources::attachments` 已经在做）
可以直接生成这个文件。**不需要 Maven/Gradle。**

### 2.2 java-ls（架构最贴，但无 license）

- 仓库：`tsmaeder/java-ls`，2026-03 创建，**2026-11-20 仍在提交**（活跃），release 0.1.1
- 作者：Thomas Mäder，前 Red Hat、Eclipse Che / LSP4J 核心成员
- 架构（关键）：**context-free 声明索引** —— 索引时**不解析 import**，只记录
  「这个文件声明了哪些类型/方法/字段」，`extends Bar` 只存 `Bar` 这个简单名。
  请求时才用编译器全解析，并把编译器的 class file 加载器**替换成从内存索引读**
  （索引项在编译器眼里就是 class file）
- 实测（作者博客，trino）：**11044 源文件 + 979 jar + 35 万类型 = 25 秒**
  内存 750MB；`java.lang.String` 全引用 26s
- **索引器可选 `turbine` / `javac` / `ecj`** ← 这条对我们最关键，NC 走 ECJ
- **前端可选 `ecj` / `javac`**
- 已实现：Hover、Go to declaration、Find References、Type Hierarchy、Code Completion、Call Hierarchy
- 架构优点：可**并行**索引、可**增量**（按 mtime 找变更文件）、可存 baseline 索引
- **缺**：只支持 Maven importer（其他要手写 `mbt.json`）；补全很粗糙；**无重构**；索引暂未持久化；无扩展 API
- **🔴 硬伤：仓库无 LICENSE**（GitHub `license: null`，1 star）⇒ 默认保留所有权利，
  **不能合法集成进商业产品**，只能读它的代码借鉴架构

### 2.3 java-index（闭源，定位「读代码」）

- 只有 VS Code Marketplace / Open VSX 分发，GitHub 上**找不到源码仓库**
- 基于 Turbine，宣称不编译、只解析成 declaration summaries
- 官方对比（spring-petclinic 小项目）：冷启 **1.5s**（jdtls 2.7s）、内存 **250MB**（1.8GB）、
  Find references **2ms**（385ms）
- **不支持**编译错误、补全、重构；Lombok 生成成员看不到
- 需要 **JDK 21+** 跑 daemon

小项目数字说服力有限（我们的量级要看 java-ls 的 trino 数字），且闭源 ⇒ 只能作为
「这类架构能有多快」的旁证。

## 3. 逐项对照我们的约束

| 约束 | Metals v2 | java-ls | java-index |
|---|---|---|---|
| 适配自制 `.classpath`（不用 Maven/Gradle） | ✅ 手生成 mbt.json | ✅ 同 | ❌ 只吃 build tool |
| **ECJ 编译语义**（NC 走 ECJ） | ❌ 只有 Turbine/javac | ✅ **indexer 可选 ecj** | ❌ Turbine |
| 运行时 JDK | 17+（Turbine） | 17/21 | **21+** |
| 补全 | 有 | 粗糙 | ❌ |
| 诊断 | 有 | 有 | ❌ |
| 重构 | ❌ | ❌ | ❌ |
| 调试 DAP | 需 BSP server | ❌ | ❌ |
| 扩展我们自己的 bundle | ❌ | ❌ | ❌ |
| 许可证可商用 | ✅ Apache-2.0 | ❌ **无 license** | ❌ 闭源 |
| 成熟度 | M2 里程碑 | PoC（作者自述 YMMV） | 已上架 |

**没有一个是「装上就能替」的。** 四个 ❌ 里有三个（重构、调试、扩展 bundle）是产品功能缺口，
不是性能问题。

## 4. 正确架构：快慢双通道（S4 强化版）

这轮调研真正的收获不是「换引擎」，而是**Phase 1 有比 single 语义实例更好的选择**。

原 S4：
- Phase 1：single 语义实例（只链当前模块，~46s 可用）
- Phase 2：flat 语义实例（154~355s）

强化后：
- **Phase 1：声明索引**（context-free，全工作区，**25s 级**）→ 跳转/引用/类型层级/补全可用，
  **且覆盖所有模块**，不是只当前模块
- **Phase 2：flat 语义实例** → 诊断/重构/重命名/DAP 逐步接管

这把 Phase 1 从「46s + 只有一个模块」变成「25s + 全部模块」，是净改善。

### 落地三条路，按成本排

| 方案 | 做法 | 成本 | 风险 |
|---|---|---|---|
| **A. 嵌 java-ls 的编译产物** | 无 license ⇒ **不可** | — | — |
| **B. 嵌 Metals v2** | 加一个 Scala 运行时依赖；生成 mbt.json | 中 | M2 不稳定；Turbine 对 NC 1.6/1.7 语法的兼容未知 |
| **C. 自建声明索引** | 复用它的架构：不解析 import 的声明索引 + Bloom filter 候选 + 按需全解析 | 中高 | 要写 Java 侧 indexer（Rust 解析 Java 到方法级不可行） |

**推荐 C 的思想 + B 的验证**：先用 Metals v2 在我们真实工程上量一次「25s 是否成立」，
成立就按 C 自建（不引 Scala 依赖），不成立就说明我们的代码特征（NC 大量 jar、ECJ 语义）
让它失效，回到原 S4。

### 🔴 必须先说清的一件事

**S3（常驻）做完后，双通道的边际收益会大幅下降。** 因为「等 3~6 分钟」从「每个模块一次」
变成「一天一次」。双通道优化的是那「一天一次」和「换工作区」。

所以顺序不能颠倒：

1. **S3 常驻** —— 收益最大、成本最低、不引新依赖
2. **S4 Phase 1 换声明索引** —— 优化剩下的一次
3. **不整体替换 jdt.ls**

## 5. 现在就能拿的两样东西

1. **`mbt.json` 的格式**（Metals 定的 workspace 描述文件）—— 比我们的影子工程
   `.classpath` 更适合做跨工具交换。将来若接任何第三方 LS，生成它就行，我们已有全部素材
2. **context-free 索引的三条设计约束**（java-ls 实证过的）：
   - 索引阶段**不解析 import** ⇒ 单文件独立 ⇒ **可并行**
   - 引用查找用 **Bloom filter 预筛**（候选集）再精确验证 ⇒ 避免全库解析
   - 索引项**在编译器眼里就是 class file** ⇒ 请求时能复用编译器全解析，不必自写类型系统

## 6. 复现与出处

```bash
# Metals v2 分支与版本
curl -s https://api.github.com/repos/scalameta/metals/branches?per_page=100 | grep main-v2

# java-ls 活跃度（注意 license 为空）
curl -s https://api.github.com/repos/tsmaeder/java-ls | grep -E '"license"|"pushed_at"|"stargazers_count"'
```

- java-ls 架构与 trino 实测：https://www.castleridge.ch/blog/java-ls-indexing-that-scales
- Metals v2 能力/限制/mbt.json：https://metals-lsp.org/
- Databricks 开源说明（TTII p50 8.7s / 26M 行）：databricks blog「Open-sourcing Metals v2」
- java-index（闭源对比数字）：VS Code Marketplace `gobinath.java-index`
