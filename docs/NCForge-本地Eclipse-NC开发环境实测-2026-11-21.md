# 本地 Eclipse 跑 NC 代码的完整链路实测

> 2026-11-21 · 目的：不再凭「行业软件大概怎么做」推演，直接拆本机这套真实在用的环境，
> 用它校准 `NCForge-智能代码-单索引常驻-规划-2026-11-21.md`（下称「规划」）。
>
> 所有结论都有文件路径 / 实测数字，能当场复核。

## 1. 环境清单

| 项 | 实测值 |
|---|---|
| Eclipse | **4.11.0**（2019-03，EPP JEE 包） |
| Eclipse 安装 | `D:\tool\eclipsehy` |
| VM | `C:/ufjdk/bin/javaw.exe`（JDK 1.8），`-Xmx2024m`，G1GC |
| workspace | `C:\work\aier` |
| NC home | `D:\ncc\1909home` |
| 用友插件 | `dropins/yonyouplugins/plugins/`：`nc.uap.mde_1.0.0`、`NCPlugin`、`NCExport`、`NCMDP`、`uapstudio.build.check`、`uapstudio.patch`、`ria.g2.launching` 等 |
| 额外插件 | `dropins/nc.debug.bridge_1.0.0.jar`（**2026-10-08** 加入，HTTP 热重载桥，见 §7） |

## 2. 工程形态：NC 官方就是 flat

### 2.1 一个工程装 63 个模块

```
C:\work\aier\newar\.project          → <name>ar</name>
C:\work\aier\newar\                → 63 个模块目录（aert/aim/ali/ampub/arap/…）
C:\work\aier\newar\gl\             → 没有 .project！只是 ar 的一个目录
```

**newar 下没有任何模块级 `.project`**。整个 NC 开发区是**一个 Eclipse project**，模块只是它的源根。

### 2.2 `.classpath` 的真实结构（237 行）

| kind | 条数 | 说明 |
|---|---|---|
| `src` | **223** | 每条形如 `output="gl/classes" path="gl/src/public"` |
| `con` | **10** | 1 个 JRE + **9 个用友自定义 container** |
| `output` | 1 | 全局默认 `out/bin` |
| `lib` | **0** | **一条 jar 都没有** |

9 个 container 是：

```
nc.uap.mde.library.container/Ant_Library
                              /Product_Common_Library
                              /Middleware_Library
                              /Framework_Library
                              /Module_Public_Library
                              /Module_Client_Library
                              /Module_Private_Library
                              /Module_Lang_Library
                              /Generated_EJB
```

源根覆盖 63 个模块，每个模块 4~5 条（`src/public`、`src/client`、`src/private`、`resources`、`src/test`），
实际存在几条就写几条，共 223 条。

### 2.3 输出是 per-source 的，34 种目录

```
output="aert/classes"  output="gl/classes"  output="bcbd/classes" …
output="out/baseapp"   output="out/bill"    （少数模块走 out/<模块>）
kind="output"          → out/bin            （默认，装外部源码：cn/com/weaver/nccloud…）
```

实测 `newar/gl/classes` 下有 `nc/**/*.class`，`out/bin` 下有 `cn com lang localhost nc nccloud uap weaver`。

**结论：模块的编译边界靠「给每条 src 指定 output」保留，不靠独立 project。**

## 3. 编译链路：两个 builder

`newar/.project` 的 buildSpec：

```xml
<buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand>
<buildCommand><name>nc.uap.mde.ModuleBuilder</name></buildCommand>
```

natures：`javanature` + `nc.uap.mde.ModuleProjectNature` + `nc.uap.mde.BizCompProjectNature`。

`ModuleBuilder` 的反编译签名（`nc.uap.mde_1.0.0.jar`）：

```java
public class ModuleBuilder extends IncrementalProjectBuilder {
    protected IProject[] build(int kind, Map args, IProgressMonitor monitor);
    private void compileFile(IPath, IFile, IProgressMonitor);   // 逐文件编译
    private void removeOutputFile(IPath, IFile, IProgressMonitor); // 删陈旧产物
    private void copyFolderTo(IFolder, IPath);                  // 资源目录原样拷
}
```

要点：

- 它是 **IncrementalProjectBuilder** + `DeltaVisitor`，**按 delta 逐文件**编译，不是全量重编
- 用友**没有把编译完全交给 javabuilder**：`compileFile` / `removeOutputFile` / `copyFolderTo` 是自己实现的，
  目的是把产物按模块落到 `<模块>/classes` 并处理非 java 资源
- 所以「NC 的模块编译」= javabuilder 做标准增量 + ModuleBuilder 做模块化落地，两者都在

## 4. 跳转链路：JDT 持久索引

| 项 | 实测 |
|---|---|
| 索引位置 | `C:\work\aier\.metadata\.plugins\org.eclipse.jdt.core\` |
| 索引形态 | `<projectHash>.index`，**每工程一个文件** |
| 文件数 | **6136 个** `.index` |
| 总体积 | **1018 MB** |
| 最大单文件 | 27.8 MB（`290267995.index`） |
| 版本标记 | `indexNamesMap.txt` = `INDEX VERSION 1.131` |
| `index.db` | **0 字节**（旧格式已弃用，2021-12 起） |

6136 个远多于当前工程数，说明**索引只增不减**（工程删除/改名后残留不自动清理）。

跳转路径：

```
Ctrl+点击 → 查 .index（name → 文档路径 + offset）→ 打开文件 → 只对这一个文件 reconcile（AST + binding）
```

**这就是 Eclipse 快的原因**：索引是**持久化 + 增量 + name/path 粒度**，跳转不需要全 workspace 的 AST；
打开文件才做解析。1018MB 说明索引并不小，**快的原因是「建一次 + 增量 + 按需」，不是索引轻量**。

## 5. 运行链路：`nc.uap.mde.launch`

workspace 里 100 个 launch 配置：

| 类型 | 个数 | 用途 |
|---|---|---|
| `org.eclipse.jdt.launching.localJavaApplication` | 80 | 跑 main / 测试类（`MAIN_TYPE=nccloud.api.testcase.base.AHISPostTest` 之类） |
| **`nc.uap.mde.launch`** | **16** | **启动 NC 客户端 / JStarter** |
| `remoteJavaApplication` | 2 | 远程调试 |
| `org.eclipse.pde.ui.RuntimeWorkbench` | 1 | Eclipse 插件开发用，与 NC 无关 |
| jUnit | 1 | — |

`nc.uap.mde.launch` 的全字段（`EyePortal_JStarter.launch`）：

```xml
<launchConfiguration type="nc.uap.mde.launch">
  <stringAttribute key="org.eclipse.jdt.launching.CLASSPATH_PROVIDER"
                   value="nc.uap.mde.MiddlewareClasspathProvider"/>
  <stringAttribute key="org.eclipse.jdt.launching.MAIN_TYPE"
                   value="nc.starter.test.JStarter"/>
  <stringAttribute key="org.eclipse.jdt.launching.PROJECT_ATTR" value="EyePortal"/>
  <stringAttribute key="org.eclipse.jdt.launching.WORKING_DIRECTORY"
                   value="${FIELD_NC_HOME}"/>
  <stringAttribute key="org.eclipse.jdt.launching.VM_ARGUMENTS"
                   value="-Dnc.runMode=develop -Dnc.jstart.server=${FIELD_CLINET_IP}
                          -Dnc.jstart.port=${FIELD_CLINET_PORT} -Xmx768m -XX:MaxPermSize=256m"/>
</launchConfiguration>
```

即：**跑 `nc.starter.test.JStarter` 的 main，工作目录是 NC home，classpath 由用友的
`MiddlewareClasspathProvider` 现算，靠 `-Dnc.runMode=develop` 让客户端从本地 classes 加载。**

## 6. 对规划的 5 条修正（重要）

### 6.1 ✅ flat 不是我们的发明，是 NC 官方形态 —— 决策得到最强印证

`newar` = 1 project + 223 src + 63 模块，6 个 NC 启动配置全指向 `PROJECT_ATTR=newar`。
规划里「flat vs multi」的犹豫可以结束：**multi 才是偏离官方的那条路**。

### 6.2 ❌ 规划里「撤掉有源码模块的 class 目录」是错的

官方做法不是撤，而是**给每条 src 指定 `output="<模块>/classes"`**。

- `.classpath` 的 `src` 条目带 `output` 时，该目录是**输出**，不会被当 classpath 输入读 →
  从机制上就不会出现「陈旧字节码压过源码」
- 模块边界在输出层天然保留，`own_output_dirs` 那套剔除逻辑可以大幅简化
- jdt.ls 读的是标准 JDT `.classpath`，**这个属性直接支持**

⇒ S1 的实现要从「撤 class 目录 + 把 classes 换 src」改成「**保留 classes 条目语义，改成每条 src 带 output**」。

### 6.3 ⚠️ 「jar 并集」是伪问题的一半：官方根本不列 jar

`.classpath` 里 `kind="lib"` = **0 条**，全靠 9 个自定义 container 动态解析。

- 说明「全量库」在 Eclipse 里是常态，不是性能灾难 —— 「jar 并集撑大 classpath」的担忧可以降级
- **但 jdt.ls 用不了这 9 个 container**：自定义 container 需要插件注册 `classpathContainerInitializer`，
  我们的独立 jdt.ls 分发里没有用友插件，写了也解析不了 → **必须展开成 `<classpathentry kind="lib">` 列表**
- 改进方向：展开时**按官方这 9 个维度分类**（Ant / Product_Common / Middleware / Framework /
  Module_Public / Module_Client / Module_Private / Module_Lang / Generated_EJB），比现在只按 import 精选更接近官方语义，
  也更容易解释「为什么这个 jar 在」
- S0 的「jar 并集」测量保留，但预期风险从「可能暴增」降为「官方全量也就这样」

### 6.4 ❌ 规划漏了「运行」

用户最初的问题是「看代码跳转要等」，但完整工作流里还有**运行**。官方是
`JStarter + -Dnc.runMode=develop + WORKING_DIRECTORY=NC home + MiddlewareClasspathProvider`。

对规划的直接影响：`compile.rs` 的产物布局必须和 ModuleBuilder 对齐（`<模块>/classes`），
否则「本地编译完直接跑 `nc.runMode=develop`」这条官方工作流在我们这里不成立。
S5 的「自动编译仍按模块」判据应改成「**与 ModuleBuilder 同语义**」，不是「与 javabuilder 同语义」。

### 6.5 ✅ 增量缺口被 1018MB / 6136 文件再次印证

Eclipse 的索引是**长期增量累积**的（从 2021 留到 2026）。规划 §2.5 缺口一（前端从不发
`didSave` / `didChangeWatchedFiles`）在 flat 之后会成为硬伤，S2.5 不能省。

## 7. 额外发现：`nc.debug.bridge`（2026-10-08）

```
dropins/nc.debug.bridge_1.0.0.jar   7961 B
nc/debug/bridge/Server.class       11103 B
nc/debug/bridge/Startup.class       1483 B
Require-Bundle: org.eclipse.ui, swt, core.runtime, core.resources,
                debug.core, debug.ui, jdt.core, jdt.debug, jdt.launching
```

`Server` 的反编译签名：`ServerSocket` + `token` + `URLClassLoader` + `reload()` + `parseQuery()`。

这是一个**跑在 Eclipse 里的 HTTP 端点**，能力是「加载/热重载某个 jar」，不是通用 JDT 代理。
但它的存在说明一件事：**本机已经验证过「外部进程 ↔ Eclipse 插件」这条通道可做**。

⇒ 由此多出一条**没进规划的备选路线（方案 E：桥接 Eclipse）**：

| | 自建 flat + jdt.ls（规划现状） | 桥接本机 Eclipse |
|---|---|---|
| 索引成本 | 自建，cold ~128s，warm 待测 | **0**，直接用官方 1018MB 索引 |
| 编译 | 自写 `compile.rs` | 复用 ModuleBuilder |
| 运行 | 需自建 JStarter 启动 | 复用 `nc.uap.mde.launch` |
| 前提 | 只需 NC home | **必须装 Eclipse + 用友插件 + 用户在 Eclipse 里打开该 workspace** |
| 风险 | 索引/增量要自己兜 | 强依赖外部 IDE、双进程状态同步 |

不适合替代主路线（要求用户在 Eclipse 里干活与我们「一体化工作台」的定位冲突），
但**「Eclipse 正开着时，跳转/编译代理过去」可以作为一个可选加速档**，成本远低于 S6 预建索引。

## 8. 未验证 / 边界

- 9 个 container 的实际 jar 清单没有导出（需要跑在 Eclipse 进程里调 `IClasspathContainer.getClasspathEntries()`）。
  若要做 §6.3 的分类展开，得先写一个 Eclipse 侧的小导出脚本，或用 `nc.debug.bridge` 那条通道取
- `ModuleBuilder.build()` 的 delta 粒度只从签名看出「逐文件」，没验证它是否也处理跨模块依赖失效
- 1018MB 索引里有多少属于已删除工程没统计（6136 个文件明显含残留）
- `-Dnc.jstart.server` 指向的应用服务器（中间件）不在本次调研范围

## 9. 复现命令

```bash
# 工程形态
cat /c/work/aier/newar/.project
grep -c 'kind="src"' /c/work/aier/newar/.classpath     # 223
grep -o 'kind="[a-z]*"' /c/work/aier/newar/.classpath | sort | uniq -c

# 索引
du -sh /c/work/aier/.metadata/.plugins/org.eclipse.jdt.core   # 1018M
ls /c/work/aier/.metadata/.plugins/org.eclipse.jdt.core/*.index | wc -l  # 6136

# 运行
ls /c/work/aier/.metadata/.plugins/org.eclipse.debug.core/.launches/*.launch | wc -l
cat "/c/work/aier/.metadata/.plugins/org.eclipse.debug.core/.launches/EyePortal_JStarter.launch"

# builder
/d/tool/eclipsehy/jdk1.8/bin/javap.exe \
  -classpath /d/tool/eclipsehy/dropins/yonyouplugins/plugins/nc.uap.mde_1.0.0.jar \
  -p nc.uap.mde.internal.core.builders.ModuleBuilder
```
