# NC 启动 dev 的完整链路 与 类加载机制（本机反编译实证）

> 证据来源：本机 `D:/ncc/1909home` 的 `starter.jar`（11 个类）、`middleware/mw.jar`（174 个类）、
> `bin/startServer.bat`、`bin/uapSetupCmdLine.bat`、`ierp/bin/prop.xml`，用 CFR 0.152 反编译后逐行读；
> 关键行为用 ufjdk 1.8 跑对照实验验证（§6）。
> **凡本文标注「实测」的，都跑过；标注「推断」的，都给了验证方法。**
>
> 日期：2026-10-31　状态：机制已闭合，待据此改代码

---

## 0. 一页结论

**官方启动时 `-classpath` 只有 4 个 jar，剩下 7000+ 个 jar 和所有模块 classes 都由 NC 自己的
`BootstrapClassLoader` 按目录结构在运行时扫描加载。** 这不是细节差异，是**根本机制的差异**：

```
官方：java -cp starter.jar;tools.jar;ant-launcher.jar;cnytiruces.jar  nc.bs.mw.start.NCStarter
       └─ BootstrapClassLoader 自己扫 8 段目录
我们：java -cp <pathing.jar 里塞 4400+ 条目>  ufmiddle.start.tomcat.StartDirectServer
       └─ 绕过 NC 的类加载器，所有 jar 直接躺在 app classloader
```

由此产生六个偏差（§5）。**E1 由 `290110a` 修掉主体，E2/E3/E5/E6 已于 2026-10-31 本轮修掉
（§11），只剩 E4 的模块 15 层枚举**。改动前其中两个会直接导致「启动 dev 失败 / 页面打不开」：

| # | 偏差 | 后果 | 严重度 | 现状 |
|---|---|---|---|---|
| **E2** | `-Duap.hotwebs` 写死 5 个，本机实际有 **18 个** hotwebs，13 个被静默跳过 | 前端页面 404，但服务"启动成功" | **P0** | ✅ 已改实扫 |
| **E5** | 不扫 `external/classes`（33 个二开业务类）与 `NCHOME/resources/`（20 个类，framework 热修复 + 新增） | **`external/` 是 bootstrap 第 4 位，优先级高于所有 modules**；`resources/` 能压过 `lib/*.jar` 里的原版类。两条覆盖通道在我们这里都断了 | **P1（已实证）** | ✅ 已补 |
| **E3** | 不设 `-Dnc.server.name`，与 `prop.xml` 的 `<name>xuyserver</name>` 不一致 | `findServerProcessInfo` 返回 null，端口/地址配置走默认值；`work/server/` 与配置分叉 | P1 | ✅ 已补 |
| E4 | jar 顺序自己拼（`lib` 抢在 `framework`/`external` 前），模块 jar 段序也与官方不同 | 同名类谁生效与官方不同 | P1 | 🟡 NC home 侧已按段序重排；模块 15 层未做 |
| E6 | 用 pathing jar，官方用裸 `-cp` | `develop` 模式下有一个 NPE 陷阱（§4.2） | P1（有前置条件） | ✅ 已加前置拦截 |
| ~~E1~~ | ~~`modules` 段只收 1 层~~ | **已由 `290110a` 修成 6 段**；剩余 `extension`/`_classes`/`resources` 三类本机为 0 | ✅ 主体已修 | ✅ |

---

## 1. 完整启动链（逐环，带源码位置）

### 1.1 入口不是你以为的那个

`bin/startServer.bat:15` 真正起的是：

```bat
%JAVA_HOME%\bin\java -classpath %NC_CLASSPATH% ^
  -Dnc.bs.logging.format=text ^
  -Dnc.server.location=%NC_HOME% ^
  -Dorg.owasp.esapi.resources=%NC_HOME%/ierp/bin/esapi ^
  nc.bs.mw.start.NCStarter start
```

而 `NC_CLASSPATH` 在 `bin/uapSetupCmdLine.bat:73` 定义 —— **只有 4 个 jar**：

```bat
set NC_CLASSPATH="%NC_HOME%\starter.jar";"%JAVA_HOME%\lib\tools.jar";"%ANT_HOME%\lib\ant-launcher.jar";"%NC_HOME%\lib\cnytiruces.jar"
```

> 这一行是整个类加载机制的钥匙。`modules`、`lib`、`framework`、`middleware` **全都不在这里**。

### 1.2 调用链

```
startServer.bat
└─ nc.bs.mw.start.NCStarter.main                                   [starter.jar]
   ├─ 清 work/**/{tldCache.ser, SESSIONS.ser}                      （NCStarter:27-49）
   ├─ setProperty nc.run.side=server, run.side=server              （NCStarter:17-18）
   ├─ BootstrapClassLoader.getBootstrapClassLoader(ncHome)         ← 建 8 段类加载器（§2）
   ├─ Thread.setContextClassLoader(loader)                         （NCStarter:21）
   └─ loader.loadClass("nc.bs.mw.domain.Main").main(args)          （NCStarter:22-24）
      └─ nc.bs.mw.domain.Main.main                                 [middleware/mw.jar]
         ├─ 读 ierp/bin/prop.xml → DomainInfo                      （Main:37-45）
         ├─ 单 server 且 -Dnc.server.withDaemon=false
         │    → AloneBootstrap.main(args)    ← 同一个 JVM（Main:122-129）
         └─ 否则 → 起子进程（ManagedServerProcess.getStartCmdLine, :307-351）
              java <jvmArgs> -Duser.timezone=GMT+8 -Dnc.server.name=<名字>
                   -DNC_JAVA_HOME=... -cp <父cp>:<prop的classPath>
                   nc.bs.mw.start.AloneBootstrap start
            └─ nc.bs.mw.start.AloneBootstrap.main                  （AloneBootstrap:8-15）
               ├─ BootstrapClassLoader.getBootstrapClassLoader(ncHome)   ← 再建一次
               └─ nc.bs.mw.fm.ServiceManagerDaemon.main
                  └─ ServiceManagerDaemon.start                        （:47-56）
                     ├─ ServiceManager.init()
                     │    ├─ nc.server.prop 默认 "./ierp/bin/prop.xml"   （ServiceManager:328-332）
                     │    └─ new MiddleProperty(propXml) → MiddleParameter
                     └─ ServiceManager.start()   [线程 MiddlewareServiceManager]（:153-195）
                        ├─ initJndiEnv()            装 SecurityManager / JNDI / 事务池
                        ├─ initEJBConfiguration()   classpath 的 /BMTProxy.xml /CMTProxy.xml + ./ejbXMLs/*.xml
                        ├─ initExtServiceConfiguration()
                        ├─ loadService()            prop.xml <internalServiceArray> → Class.forName
                        ├─ startService()           base → key，顺序由 ServiceList 决定
                        └─ await()                  等 work/<server>/port 上的 SHUTDOWN socket

prop.xml 的两个内部服务（ierp/bin/prop.xml:17-32）：
   ① name=StartTomcat   class=nc.bs.tomcat.startup.BootStrapTomcatService
   ② name=EJB_SERVICE   class=nc.bs.mw.naming.EJBContainerService
```

### 1.3 Tomcat 这一环

```
BootStrapTomcatService.run()                     [mw.jar]
├─ setProperty org.apache.catalina.startup.EXIT_ON_INIT_FAILURE=true
└─ new nc.bs.tomcat.startup.Bootstrap(baseDir, serverName).start()
   ├─ BrightTomcat 实例，baseDir = NC home
   ├─ 【develop 分支】if nc.runMode == "develop"
   │    projectdir = Bootstrap.class.getResource("/").toURI() 的上两级    ← 见 §4.2
   │    setProperty nc.actor.port 默认 7886
   ├─ 扫 projectdir 下一级：含 WEB-INF/web.xml 的目录 → addWebapp，ctx.setDelegate(true)
   ├─ hotwebs：develop 下只挂 -Duap.hotwebs 白名单里的                     ← 见 §4.3
   ├─ 兜底 webapps/nc_web → 挂 "/"
   └─ 端口：-Dnc.http.port > prop.xml <http><port> > 默认 80              （Bootstrap:161-164）
```

### 1.4 两条路径的差异（重要）

| | 官方 `startServer.bat` | 我们 `launch.rs` |
|---|---|---|
| 主类 | `nc.bs.mw.start.NCStarter` | `ufmiddle.start.tomcat.StartDirectServer`（`:26`） |
| 是否经 `nc.bs.mw.domain.Main` | 是（读 DomainInfo、定 serverName、可起子进程） | **否**，直接进 `ServiceManagerDaemon` |
| `-cp` | 4 个 jar | pathing jar（4400+ 条目） |
| `nc.runMode` | 不设 | **设 develop**（`:92`） |

`StartDirectServer` 的字节码只有 4 步（`javap` 实证）：

```java
System.setProperty("nc.run.side", "server");
if (args[0].endsWith(".xml")) setProperty("nc.server.prop", args[0]);
if (!"start".equals(args[0]) && !"stop".equals(args[0])) args = new String[]{"start"};
nc.bs.mw.fm.ServiceManagerDaemon.main(args);
```

它**跳过** `Main`，所以：
- **不读** `prop.xml` 的 DomainInfo → `findServerProcessInfo` 找不到 server → 端口用默认 80、地址用默认
- **不设** `nc.server.name` → `ServiceManagerDaemon:31-35` 用默认 `"server"`，而 `prop.xml` 里是 `xuyserver`
- 但**仍然**会走到 `nc.bs.tomcat.startup.Bootstrap.start()` —— 也就是说 `develop` 分支照样执行

---

## 2. 类加载机制（这才是「顺序」的真源）

### 2.1 BootstrapClassLoader 的 8 段

`nc/bs/mw/start/BootstrapClassLoader.java:23-52`，**顺序即优先级**：

| 位 | 目录 | 收法 |
|---|---|---|
| 1 | `middleware/` | `computeJarCPInLib` → 递归收 jar |
| 2 | `ant/lib/` | 同上 |
| 3 | `framework/` | 同上 |
| 4 | `external/` | `computeStandCP`（§2.2 的 15 层） |
| 5 | **`NCHOME/` 根** | `computeStandCP` |
| 6 | `ejb/` | `computeJarCPInLib` |
| 7 | **`modules/`** | `computeModulePublicCP`（§2.3） |
| 8 | `langlib/` | `computeJarCPInLib` |

`URLClassLoader` 语义：**按 addURL 顺序查找，命中即止**。所以第 1 位 `middleware/` 的类
**优先于**任何模块的类。

### 2.2 `computeStandCP`：单目录内的 15 层

`ClasspathComputer.java:23-65`。给定一个目录（NC home 根，或某个 `modules/<m>`），按此顺序收集：

```
① extension/_classes/     ② extension/classes/     ③ extension/resources/
④ extension/lib/*.jar     ⑤ extension/_lib/*.jar
⑥ hyext/_classes/         ⑦ hyext/classes/         ⑧ hyext/resources/
⑨ hyext/lib/*.jar         ⑩ hyext/_lib/*.jar
⑪ _classes/               ⑫ classes/               ⑬ resources/
⑭ _lib/*.jar              ⑮ lib/*.jar
```

三条要点：

1. **`hyext` 在标准层之前**（⑥⑦⑧⑨⑩ vs ⑪⑫⑬⑭⑮）— 用户说的"类加载优先加载 hyext"是对的，
   **但它不是全局最前，`extension` 还在 `hyext` 之前**。
2. **jar 紧跟自己那一层**，不是所有 classes 在前、所有 jar 在后。写成"先全部散类、再全部 jar"
   会让 `hyext/lib` 的优先级掉到标准 `classes` 之后（实测见 §6.4）。
3. **`resources/` 不是"资源目录"，是官方的"覆盖 + 新增"目录**。本机 `NCHOME/resources/` 有 20 个 `.class`：
   `nc/bs/framework/server/deploy/ModulesMonitor.class`（`lib/fwserver.jar` 里也有 ⇒ 能覆盖）、
   `nc/bs/framework/core/AbstractDeployer.class`（jar 里没有 ⇒ 纯新增）、
   以及几个 `org/apache/catalina/*` 的（`middleware/tomcat.jar` 里也有，但**压不过**，见 §5 E5）。
   它排第 ⑬ 层，`lib/*.jar` 排第 ⑮ 层 ⇒ **同属第 5 位时 `resources/` 赢**。

`listFiles` 递归子目录，且每层内 `Collections.sort()`（jar 文件名**字典序**，`ClasspathComputer:174`）。

### 2.3 `computeModulePublicCP`：模块如何被找到和排序

```java
computeModuleDirs(modulesDir)                 // 递归找模块
  → 每个模块目录调 computeStandCP()           // 套用 §2.2 的 15 层
  → 全部平铺进一个 URL[]
  → Collections.sort(moduleList, new ModuleComparator(dbf))
```

**模块的判定标志是 `META-INF/module.xml`，不是 `.upm`**（`ModuleFilter:14-19`）：

```java
if (pathname.isDirectory()) {
    File subFile = new File(pathname, "META-INF/module.xml");
    return subFile.exists();
}
```

本机实测：245 个模块目录中 **243 个**有 `META-INF/module.xml`。

**排序规则**（`ModuleComparator:15-30`），三级：

```
① module.xml 的 priority 属性（解析失败/缺省 = 10）   升序
② 名字以 "uap" 开头的排前面
③ 名字字典序
```

本机实测：**245 个模块的 module.xml 里没有一个带 priority 属性** —— 所以排序实际退化为
「uap 前缀优先 → 字典序」。这意味着 `uapbd` 排在 `gl` 之前、`uapfw` 排最前。

### 2.4 JarFilter：`_src.jar` 与 `_doc.jar` 被排除

`JarFilter:12-24`：

```java
if (name.endsWith(".jar")) return !name.endsWith("_src.jar") && !name.endsWith("_doc.jar");
if (name.endsWith(".zip")) return !name.endsWith("_src.zip") && !name.endsWith("_doc.zip");
```

**这解释了参考插件 `X_src.jar` 双产物的由来**：`_src.jar` 是源码包，运行时被过滤器排除，
只给 IDE 挂源码用。我们出包形态不需要它（不做 IDE 集成），但**如果将来要支持"看源码"，
这里就是官方的命名约定**。

> 反过来说：**我们现在的 `collect_archives` 会把 `_src.jar` / `_doc.jar` 也收进 classpath**，
> 而官方会排除。这是个（小而确定的）偏差。

### 2.5 webapp 采用「先父后子」

`Bootstrap.java` 里每个工程 webapp 都调了 `ctx.setDelegate(true)`（`:84 / :90`）：

- Tomcat 默认 `delegate=false`：webapp 的 `WEB-INF/classes`、`WEB-INF/lib` **优先**
- NC 设 `true`：**先委托父加载器（BootstrapClassLoader），找不到才用 webapp 自己的**

所以：**类的主战场是 §2.1 的 8 段**，`webapps/*/WEB-INF/classes` 只是兜底。
这条直接说明：想"改一个类立刻生效"，必须让它在 8 段里排在前面，光改 webapp 目录没用。

---

## 3. 一张图（优先级从高到低）

```
                    ┌─ middleware/ (jar)
                    ├─ ant/lib/ (jar)
                    ├─ framework/ (jar)
BootstrapClassLoader├─ NCHOME/external/     ← 15 层
  (app 层，唯一真源) ├─ NCHOME/ 根           ← 15 层
                    ├─ ejb/ (jar)
                    ├─ modules/<m>/ ...      ← 15 层，模块按 priority→uap→字典序
                    └─ langlib/ (jar)
                            ↓ 找不到才往下
                    webapp 的 WEB-INF/classes, WEB-INF/lib   （delegate=true 的兜底）
```

---

## 4. `nc.runMode=develop` 的三个隐藏开关

我们在 `launch.rs:92` 设了 `-Dnc.runMode=develop`。这个值在 `Bootstrap.start()` 里打开三段
**普通模式不会执行**的逻辑 —— 它们是"启动 dev"的全部含义，也是三处陷阱。

### 4.1 开关一：`projectdir` 的来源

```java
if ("develop".equals(System.getProperty("nc.runMode"))) {
    projectdir = new File(Bootstrap.class.getResource("/").toURI()).getParentFile().getParent();
    System.setProperty("nc.actor.port", System.getProperty("nc.actor.port", "7886"));
}
```

**没有 try-catch。** `projectdir` 由"classpath 里第一个**目录**条目"往上两级得到。

### 4.2 陷阱：classpath 全是 jar 时这里 NPE

实测（§6.2）：classpath 里没有任何目录条目时，`getResource("/")` 返回 **null**：

```
getResource("/") = null
!!! EXCEPTION: java.lang.NullPointerException
```

而这段代码在 `develop` 分支里，无 try-catch → 异常抛到
`BootStrapTomcatService.run()` 的 `catch (Exception e) { log.error("start tomcat error"); System.exit(-1); }`
→ **整个 JVM 退出，Tomcat 根本没起来**。

**触发条件**：`nc.runMode=develop` 且 classpath 里一个目录条目都没有。
对我们而言就是：**工程一个模块都没编译过**（`<模块>/classes` 全不存在，而 NC home 侧我们只收 jar）。

> 这解释了「编译报错 → 启动也报错」的连环：编译失败 ⇒ 没有 classes ⇒ 启动 NPE ⇒ exit(-1)。
> 也解释了「编译过一次之后就正常」。

**这不是必然发生**：EyePortal 本机有 7 个 `<模块>/classes`，所以启动不会 NPE。
但 `projectdir` 会算成 `EyePortal`（正确）；如果第一个目录条目是 `NCHOME/modules/<m>/classes`，
`projectdir` 会变成 `NCHOME` 的父目录（错误，工程 webapp 挂不上，但也不报错）。

### 4.3 陷阱二：`uap.hotwebs` 是白名单，不是"附加项"

```java
Boolean developmentMode = Boolean.FALSE;
String mode = System.getProperty("nc.runMode");
if (mode != null) developmentMode = "develop".equals(mode);
HashSet<String> hws = null;
if (developmentMode) {
    hws = new HashSet<String>();
    String s = System.getProperty("uap.hotwebs");
    if (s != null && !s.trim().equals("")) {
        for (String hw : s.split(",")) hws.add(hw);
    }
}
// 后面：
if (hws != null && !hws.contains(name)) {
    log.warn("ignore hotwebs webapp " + name);     // ← 静默跳过，只有 warn 日志
}
```

**语义**：develop 模式下，`hotwebs/<name>` 只有出现在 `uap.hotwebs` 里才会被挂载。
未设或设成空串，`hws` 是**空集合**（不是 null）→ 所有 hotwebs 全部跳过。

我们写死的是 `nccloud,uapws,lfw,portal,fs`（`launch.rs:104`）。本机实测 `modules` 旁边
`hotwebs/` 有 **18 个**：

```
aim  bqchart  ebvp  emm  eyeapp  fs  help  iwebap  lfw
ncchr  nccloud  portal  uapjs  uapsep  uapws  uui1  uui2  web
```

被我们静默跳过的 **13 个**：`aim` `bqchart` `ebvp` `emm` **`eyeapp`** `help` **`iwebap`**
`ncchr` `uapjs` `uapsep` `uui1` `uui2` `web`。

其中 `iwebap` 是 NCC 的主前端入口，`eyeapp` 是爱尔的业务前端 —— **如果前端页面打不开，
先看这里**。服务本身"启动成功"（只是 warn 日志），所以很容易被误判成"前端问题"。

### 4.4 陷阱三：端口的三级优先级

```java
String host = System.getProperty("nc.http.host", pi == null ? null : pi.getAddress());
String port = System.getProperty("nc.http.port", pi == null ? null : "" + pi.getPort());
int iport = port == null ? (random ? 0 : 80) : Integer.parseInt(port);
```

`-Dnc.http.port` **优先于** `prop.xml`。这纠正了我上一版方案里"不加 `nc.http.port`，
端口真源只能是 prop.xml"的结论 —— **官方明确支持它覆盖 prop.xml**，用作"临时换端口"是正当用法。
（但仍然不建议让界面上的端口与 prop.xml 分叉，那是产品决策，不是能力缺失。）

---

## 5. 我们的六处偏差（按严重度）

### E1　`modules` 段：6 段已收，仍差 3 类（P1，主体已修）

> **状态更正**：`290110a`（D0+D6）已把 `MODULE_CLASS_DIRS` 从 1 段扩到 6 段
> （public/client/private × hyext/标准），E1 的**主体已闭合**。这里保留剩余缺口。

官方对每个模块调 `computeStandCP`，收的是**模块根目录下的 15 层**；我们的 6 段与之对照：

| 官方段 | 我们 | 本机实况 |
|---|---|---|
| `hyext/classes`、`classes`（public 段） | ✅ | `classes` 49 目录 / 258 class |
| `client/hyext/classes`、`client/classes` | ✅ | 60 / 67 |
| `META-INF/hyext/classes`、`META-INF/classes` | ✅ | 50 / 80 + 1 / 1 |
| `extension/classes`、`extension/_classes` | ❌ | **0**（本机没有） |
| `_classes`（下划线前缀，优先级高于 `classes`） | ❌ | **0** |
| `resources`、`hyext/resources`、`extension/resources` | ❌ | **0** |
| `_lib`、`hyext/_lib`、`extension/_lib` | ❌ | **0** |

**本机这四类全为 0** ⇒ 现在不影响；但它们是官方的"覆盖通道"（`_classes` / `_lib` 带下划线前缀
是为了排在同名普通目录之前）。现场若用，我们看不见。

> 注意：`modules/<m>` 的 `client` / `META-INF` 段**不在官方 bootstrap 里**
> （`computeModulePublicCP` 只收 public 段），是模块 classloader 运行期加载的。
> 我们收 6 段是**有意的偏离**，理由见 §9.1。

**现场装过补丁后 `hyext/classes` 就不是 0 了**（补丁落点：`patch_view.rs:176-192`，
用户已确认现场是散文件），这一段已由 6 段覆盖，是这次修复最直接的价值。

### E2　`uap.hotwebs` 少了 13 个（P0，**已修**）

见 §4.3。

### E3　不设 `nc.server.name`，与 `prop.xml` 不一致（P1，已实证，**已修**）

`prop.xml:7` 是 `<name>xuyserver</name>`。我们用 `StartDirectServer` 跳过 `nc.bs.mw.domain.Main`，
而 `ServiceManagerDaemon:31-35` 在属性缺失时用默认 `"server"`。

**本机实测证据**：

```
D:/ncc/1909home/work/  →  只有 server/     （没有 xuyserver/）
work/server/port       →  54033
prop.xml servicePort   →  8005
```

`work/<serverName>/` 由 `ServiceManager.await()` 创建（字节码实证：`new ServerSocket(0)`
随机端口 → 写入 `new File(new File(baseDir, serverName), "port")`）。目录名是 `server`，
说明运行时 serverName 确实是默认值。

**顺带纠正一个我原先的误解**：`prop.xml` 的 `<servicePort>8005</servicePort>` **在 ServiceManager
里从来没被读过**（`servicePort` 字段只有声明和 getter，`await()` 用 `new ServerSocket(0)`）。
所以 shutdown 端口永远是随机值，8005 只是给别的工具看的。**不要试图去固定它。**

**实际影响**：
1. `Bootstrap.findServerProcessInfo(baseDir, "server")` 在 prop.xml 的 domain 里找不到 → `spi=null`
   → `<http><address>` / `<http><port>` 都退回默认值（本机碰巧也是 `127.0.0.1:80`，所以看不出来）
2. `work/server/` 与配置的 `xuyserver` 分叉 ⇒ **官方 `stopServer.bat` 停不掉我们起的服务**
   （它按 `work/<默认serverName>/port` 找端口）
3. 日志目录名同样分叉

**修法**：启动前读 `ierp/bin/prop.xml` 的 `<domain><server><name>`，传 `-Dnc.server.name=<它>`。
`startServer.bat` 自己不带这个参数，是因为它经 `Main` 读 DomainInfo 后由 `ManagedServerProcess`
补上（`getStartCmdLine:316-318`）。我们跳过 `Main`，就得自己补。

### E4　jar 的段序与官方不同（P1）

我们 `HOME_JAR_DIRS`（`launch.rs:37`）= `["middleware","lib","framework","external/lib"]`，
NC 侧 `MODULE_JAR_DIRS` 段序是 `client/hyext → client → hyext → lib → META-INF/hyext → META-INF`
（`launch.rs:39-47`）。官方是 **public → client → private**，且每段 `extension → hyext → 标准`。

### E5　`external/classes` 与 `resources/` 没扫 —— 里面有 53 个类（P1，已实证，**已修**）

先说结论：这两个不是"资源目录"，是**官方的类覆盖目录**，而且优先级极高。

**`NCHOME/external/` 在官方顺序里是第 4 位**（`BootstrapClassLoader:32`），
**早于 NCHOME 根、早于所有 modules**。本机实测：

| 目录 | 内容 | 我们（改动前） |
|---|---|---|
| `external/lib` | **589 个 jar** | ✅ 收了（`HOME_JAR_DIRS` 有 `external/lib`） |
| `external/classes` | **33 个 class**（另 3 个 `.java`） | ❌ **没收** |

> 数字更正：本节初稿写「24 个 class / 合计 44」，2026-10-31 14:30 用
> `find external/classes -name '*.class' | wc -l` 复核为 **33**，加 `resources/` 的 20 个
> 共 **53**。初稿的 24 是漏数（以 33/53 为准）。

这 33 个类是二开业务代码，不是工具类：

```
nccloud/web/pu/poorder/action/PoOrderInsertAction.class
nccloud/web/pu/poorder/action/PoOrderUpdateAction.class
nccloud/web/pu/poorder/action/PoOrderCardInterceptorAction.class
nccloud/web/pu/arrival/action/InsertAction.class
nccloud/web/pu/arrival/action/SaveSendAction.class
nccloud/web/ic/inbound/purchasein/action/PurchaseInQry23.class
nccloud/framework/web/processor/template/GridConvertProcessor.class
nccloud/platform/med/cell/fn/MedDefinedDisplaySetter.class      ← med 医疗行业定制
...
```

**`NCHOME/resources/` 里是 20 个 class**，性质是"覆盖 + 新增"，但覆盖范围有边界（我核对过，别扩大）：

```
nc/bs/framework/server/deploy/ModulesMonitor.class    ← lib/fwserver.jar 里也有 ⇒ resources 能压过它
nc/bs/framework/server/deploy/MissModule.class
nc/bs/framework/core/AbstractDeployer.class           ← jar 里没有 ⇒ 只在这里，是新增
org/apache/catalina/core/StandardContext.class        ← middleware/tomcat.jar 里也有 ⇒ 但压不过（见下）
org/apache/catalina/core/ContainerBase.class          ← 同上
org/apache/tomcat/util/threads/InlineExecutorService.class
```

**边界在哪**：`BootstrapClassLoader` 是 `URLClassLoader`，按 addURL 顺序查找。
`middleware/` 是第 **1** 位，`NCHOME/` 根是第 **5** 位（内部再分 15 层，`resources/` 在第 ⑬ 层、
`lib/*.jar` 在第 ⑮ 层）。所以：

| 原始位置 | `resources/` 能否覆盖 | 依据 |
|---|---|---|
| `lib/fwserver.jar`（如 `ModulesMonitor`） | ✅ 能（同属第 5 位，⑬ 早于 ⑮） | 实测 `fwserver.jar` 含该类 |
| `middleware/tomcat.jar`（如 `StandardContext`、`ContainerBase`） | ❌ **不能**（`middleware` 第 1 位先命中） | 实测 `tomcat.jar` 含这两个类 |

那些 Tomcat 类被放进 `resources/` 大概是给 **WAS / WLS 中间件形态**用的（不同容器 classpath 不同），
在 Tomcat 形态下它们是死代码。**结论收敛为：`resources/` 覆盖的是 `lib/` 那一层（framework 热修复），
不是 Tomcat。**

这仍然是我们缺的能力：**`NCHOME/resources/` 里的 framework 热修复类（`ModulesMonitor`
这类模块部署监控）在我们启动里不生效**，而 `lib/fwserver.jar` 里的原版会生效。
表现是"官方脚本正常、我们的工具行为不同"，且因为 jar 里是最新版，很难归因到这份覆盖。

（`modules/` 下的 `extension/*`、`_classes`、`_lib`、`resources` 本机实测**全部为 0**，
现场是否使用未知。`_classes`/`_lib` 是带下划线前缀的"更优先"变体，官方排在 `classes`/`lib` 之前，
一并按 15 层枚举即可，不额外判断。）

### E6　pathing jar 与 `develop` 模式的 NPE 陷阱（P1，有前置条件，**已加拦截**）

见 §4.2。修法有两个方向（§7）。

---

## 6. 实测记录（可复现）

环境：`D:/ncc/1909home/ufjdk`（1.8.0_202）+ CFR 0.152。

### 6.1 反编译

```bash
java -jar cfr.jar D:/ncc/1909home/starter.jar     --outputdir /tmp/starter
java -jar cfr.jar D:/ncc/1909home/middleware/mw.jar --outputdir /tmp/ncsrc
```

`starter.jar` 只有 **11 个类 / 508 行反编译代码**，但包含全部类加载机制。

### 6.2 `getResource("/")` 的四种形态（决定 `projectdir`）

| classpath | `getResource("/")` | `toURI()` → `new File()` |
|---|---|---|
| `-cp out`（目录） | `file:.../out/` | ✅ `.../out` |
| `-cp pathing.jar`（Class-Path 指向目录） | `file:.../out/` | ✅ 同上 |
| `-cp pathing.jar`（Class-Path 首项是 jar，次项是目录） | `file:.../out/` | ✅ 同上 |
| `-cp first.jar`（**只有 jar**） | **`null`** | ❌ **NullPointerException** |

结论：`getResource("")` 返回**第一个能给出根路径的目录条目**，会跳过 jar 条目；
一个目录条目都没有时返回 null。这正是 §4.2 的 NPE 来源。

### 6.3 `projectdir` 层级验证

classpath = `<root>/proj/gl/classes`：

```
getResource("/") = file:.../proj/gl/classes/
parent           = .../proj/gl
parent.parent    = .../proj          ← projectdir
```

即 `<工程根>/<模块>/classes` 的上两级 = 工程根 ✅ 与官方 develop 语义一致。

### 6.4 顺带踩到的编码坑

ufjdk 1.8 的 `javac` 默认按 GBK 读源码，UTF-8 源码直接报
`错误: 编码GBK的不可映射字符`。NC 自己的 `prop.xml:8` 也写着 `-Dfile.encoding=GBK`。

> **这纠正了我上一版方案里"NCC 应该 UTF-8"的判断** —— 那是照抄参考插件的分支逻辑，
> 而本机 `prop.xml` 明确是 GBK。参考插件的 `:328-333` 是**BIP** 分支才给 UTF-8。
> 我们锁 `-Dfile.encoding=GBK`（`launch.rs:117`）**是对的，不要改**。

---

## 7. 对既有方案的修正（哪些结论作废）

| 之前的说法 | 实际情况 | 处置 |
|---|---|---|
| "`uap.hotwebs` 写死无妨" | develop 下它是**白名单**，少列即不挂载 | **改配置项**，默认从 `hotwebs/` 目录实扫生成 |
| "`-Dnc.http.port` 不加，端口真源只能是 prop.xml" | 官方三级优先级里它最高（`Bootstrap:162`） | 结论作废；但仍不做"界面端口与 prop.xml 分叉"的产品决策 |
| "`file.encoding` 应该按版本改 UTF-8" | 本机 NCC 的 `prop.xml` 明确写 GBK；UTF-8 是 BIP 分支 | **保持 GBK**，不改 |
| "`-cp` 塞 pathing jar 是等价做法" | 机制不同：绕过 `BootstrapClassLoader` 的 8 段 | **改为主类 `NCStarter` + 4 个 jar 的官方形态**（见 §8） |
| "容器内散类 → jar 交替（6 段）" | 官方是 15 层（`extension`/`hyext`/标准 × `_classes`/`classes`/`resources`/`lib`/`_lib`） | 扩成 15 层 |
| "`prop.xml` 的 `servicePort` 8005 是 shutdown 端口" | `ServiceManager.await()` 用 `new ServerSocket(0)`，8005 从未被读 | 结论作废；停服务只能靠进程树，不能靠 `work/*/port` 或 `stopServer.bat` |
| "模块排序靠用户排序" | 官方有确定性排序：priority → uap 前缀 → 字典序 | 我们照官方算，用户只做覆盖 |

---

## 8. 建议的改法（两条路线，需你选）

### 路线 A：向官方形态对齐（推荐）

```
主类改为 nc.bs.mw.start.NCStarter
-cp 只放 4 个 jar（starter.jar / tools.jar / ant-launcher.jar / cnytiruces.jar）
```
NC 自己扫 8 段，我们只需保证**工程产物落进它扫的目录**：

- 编译输出**直接写进** `<NCHOME>/modules/<模块>/classes`，或
- 给 `<工程>/<模块>` 建一个软链/junction 到 `modules/` 下（NC 的 develop 模式思路），或
- 保留现有 classpath 注入，但**只补 NC 不扫的那部分**

优点：顺序、`_classes`/`extension`、`hyext` 优先级，全部由 NC 保证，我们不再自造一套。
代价：需要决定"工程代码怎么进 `modules/`"，这是**新的产品设计**（`nchome_deploy` 的扩展）；
且改主类会改变启动日志形态，要重做验收。

### 路线 B：保留现在的注入方式，只补齐缺口（渐进）

按「已实证 + 成本低」排序，这是建议的执行顺序：

1. **E2（半小时，最该先做）**：`uap.hotwebs` 从写死改为**实扫 `hotwebs/` 目录生成**（或用现成的
   服务页配置项）。注意：设成空串等于全不挂，必须给默认值 = 目录实测结果。
2. **E3（半小时）**：启动前读 `ierp/bin/prop.xml` 的 `<domain><server><name>`，传 `-Dnc.server.name`。
   （`prop.xml` 是 `DomainInfo` 的真源，读它比猜可靠；读失败就退回默认 `server`。）
3. **E5（1 小时）**：补 `external/classes`（bootstrap 第 4 位，优先于所有 modules）与
   NCHOME 的 `resources/`。注意位置：`external/` 要排在 modules **之前**。
4. **E6（半小时）**：classpath 里至少保证一个目录条目；未编译时给出明确提示，
   而不是让 JVM 走到 NPE → `exit(-1)`。
5. **E4 + 剩余 E1（一起改，2 小时）**：NCHOME 根与模块的 15 层完整枚举 + `_src.jar`/`_doc.jar` 排除。

优点：不动主类，风险可控，每步可独立验证；前两条加起来一小时，当场能看出变化。
代价：**我们在复刻 NC 的类加载规则**，官方一升级就可能对不上。

### 我的建议

**先做 B 的 1+2+3（合计约 2 小时，全是已实证缺口，当场可验）**，再决定要不要走 A。

理由：E2 和 E3 各自半小时，且**不需要任何架构判断**——一个是把写死的名单改成实扫，
一个是多读一个 XML 字段。E5 也是"多收两个目录"。这三条做完，"启动 dev 报错"的两个已实证
成因就都堵上了（E2 页面打不开、E6 NPE 退出另算）。

A 是终局形态，但它需要先回答"工程代码怎么进 `modules/`"这个产品问题——那是独立一轮设计，
不该混在这批里。**先让现有路径变正确，再讨论换路径。**

---

## 9. 已落地实现 vs 官方机制（逐项对照）

`290110a`（D0+D6）已经把 `MODULE_CLASS_DIRS` 从 1 段扩到 6 段、`project_class_dirs` 改读
`.classpath`。拿它跟这次反编译出的机制对一遍：

| 维度 | 官方 | 我们（`290110a` 后） | 判定 |
|---|---|---|---|
| 模块判定 | 目录 + `META-INF/module.xml` | 任意子目录 | 小差异（后面有段过滤兜底） |
| **模块排序** | `priority` → **`uap` 前缀优先** → 字典序 | 大写字典序（`sort_by_key(to_uppercase)`） | ⚠️ **实质差异，本轮新发现** |
| 模块内散类段 | **只有 public 段**（`computeModulePublicCP` 名字即此意）：`classes` / `hyext` / `extension` / `_classes` / `resources` | **6 段**（public + client + private） | 范围更宽；**编译期更好**，运行期语义不同（见下） |
| 层序 | `extension` → `hyext` → 标准 | `hyext` → 标准 | 缺 `extension` |
| 层内 | 散类 → `resources` → jar | 只有 `classes` | 缺 `resources`、`_classes`、`_lib` |
| jar 过滤 | 排除 `_src.jar` / `_doc.jar` | 未排除 | 小差异 |
| NCHOME 根 | 15 层（含 `resources/`、`external/classes`） | `middleware` / `lib` / `framework` / `external/lib` 的 jar | **缺 `external/classes`（24 个二开类）与 `resources/`（20 个类）** |
| 模块粒度 | 模块优先（A 全部 → B 全部） | 模块优先 | ✅ 一致 |

### 9.1 为什么「6 段」在编译期是对的、在运行期不是官方语义

官方的 `computeModulePublicCP` 只把**模块的 public 段**放进 bootstrap classloader；
`client/classes`、`META-INF/classes` 是**模块自己的 classloader** 在运行期按需加载的
（这就是 NC 的模块化隔离）。

我们把这 6 段全平铺进 `-cp`：
- **编译期**：正确且必要 —— ecj 要能解析 private 段的实现类，否则报 `cannot be resolved`；
- **运行期**：**比官方"更宽松"** —— 本应被模块 classloader 隔离的类，我们全放在 app classloader 里。
  好处是不会 `NoClassDefFoundError`，坏处是"同名类被错误层级的版本顶掉"时不再有隔离保护。

结论：**6 段保留**（编译期收益大于运行期的语义偏差），但要知道这是我们有意的偏离，
不是"对齐了官方"。

### 9.2 模块排序：`uap` 前缀优先 —— 这条要认真对待

`ModuleComparator:20-29`：

```java
boolean moduleStartsWithUap1 = md1.getName().startsWith("uap");
boolean moduleStartsWithUap2 = md2.getName().startsWith("uap");
if (moduleStartsWithUap1 ^ moduleStartsWithUap2) {
    return moduleStartsWithUap1 ? -1 : 1;      // uap 系一律排前面
}
return md1.getName().compareTo(md2.getName());
```

我们按大写字典序排，于是 `aim` / `arap` / `gl` 都排在 `uapbd` / `uapfw` **之前**，
而官方是 `uapfw`、`uapbs`、`uapbd` 这些**全部优先**。

`uapfw` 是框架模块、`uapbd` 是基础档案 —— 它们被排在后面意味着**业务模块的同名类会顶掉框架类**。
这正是"改了框架类不生效"的另一种成因。

**已经量过了（本机，2026-10-31）**：

```
有散类的模块:                        19
出现在 >=2 个模块的同名类:            3
两种排序下"谁赢"不同的:               0      ← 影响为 0
两种排序的模块顺序不同的位置:          19     ← 顺序本身完全不同
   ours: arap baseapp cmp ct epmp eye gl gsp ...
   official: uapbd uapbs arap baseapp cmp ct epmp eye ...
```

**结论：顺序确实全变了，但赢家一个没变。** 本机干净安装下这条**不影响结果**。

两个必须写明的限定：
1. 本机只有 **19 个**模块有散类（干净安装），现场装过补丁后会显著变多
   （补丁落 `hyext/classes`），届时同名类的数量与分布都不同；
2. 这个统计只覆盖**散类之间**，没算模块 `lib/*.jar` 之间的同名类（6280 个 jar，成本高）。

所以处置是：**不急着改，但记档**，并在补丁上线后重跑一次这个统计。
改起来只有几行（`sort_by_key` 换成 `(not startswith_uap, name)`），随时可做。

---

## 10. 现在还缺的验证（要你做或要真机跑）

| 探针 | 怎么做 | 看什么 |
|---|---|---|
| **P1** E2 是否成立 | 现在启动一次，看日志里有多少 `ignore hotwebs webapp` | 若 >0 ⇒ 那 13 个确实没挂 |
| **P2** E2 的影响面 | 看你们平时用的前端是哪个 hotwebs（`iwebap`？`eyeapp`？） | 决定它是不是"页面打不开"的原因 |
| **P3** E1 是否成立 | 装一次补丁 → 启动 → 看补丁功能在不在 | 不在 ⇒ 坐实 |
| **P4** E6 的边界 | 清掉 `EyePortal/**/classes` → 启动 | 是否 `start tomcat error` + 立刻退出 |
| **P5** E5 是否会影响现场 | 看 `external/classes` 与 `NCHOME/resources/` 里那 44 个类的修改时间 | 若接近某次发版/修复，说明现场靠它修过问题 ⇒ 必须接 |

P1 和 P4 成本最低：一个看日志，一个删目录。建议先做这两个。
P5 只查文件时间，一分钟，但能决定 E5 是 P1 还是 P2。

---

## 11. 本轮已落地（2026-10-31，路线 B 的 1+2+3 + E6 拦截）

只动 `launch.rs` 与 `nc_home.rs`，**没碰主类、没碰 pathing jar 机制**：现在仍然用
`StartDirectServer` + pathing jar，只是把「我们复刻出来的那部分 NC 规则」补正。

### 11.1 改了什么

| 缺口 | 改法 | 位置 |
|---|---|---|
| **E2** | `-Duap.hotwebs` 由 `hotwebs_names()` 实扫 `hotwebs/` 生成（按名字排序，子目录即 webapp）；目录缺失/为空时回落原来那 5 个，**绝不返回空串** | `launch.rs` `hotwebs_names` |
| **E3** | 新增 `nc_home::read_server_name()`：读 `ierp/bin/prop.xml` 的 `<domain><server><name>`，作用域限定在 `<server>` 块内（`<service>` 段里也有 `<name>`，全文件找会拿到 `StartTomcat`）；读不到回落 `DEFAULT_SERVER_NAME = "server"`，与 `ServiceManagerDaemon` 的缺省一致 | `nc_home.rs` / `launch.rs` `middleware_vm_args` |
| **E5** | `HOME_JAR_DIRS`（4 个 jar 目录）换成 `HOME_CP`（6 条，带 `CpKind::Jars/Dir`）：`middleware → framework → external/classes → external/lib → resources → lib`。类目录只在自己存在时入列 | `launch.rs` `HOME_CP` |
| **E6** | 拼参数阶段拦一道：类路径里一个目录条目都没有时直接报错并说明「develop 模式会 NPE → `start tomcat error` → exit(-1)，先编译」，不再让用户对着日志猜缺哪个 jar | `launch.rs` `middleware_spec_inner` |

**为什么 E5 顺带改了 `lib` 的位置**（原先 `lib` 排在 `framework`/`external` 前面）：不是顺手重构，
是 E5 的**必要条件**——`resources/` 只有排在 `lib/*.jar` 之前才能覆盖 `fwserver.jar` 里的同名类
（§5 E5 的边界表）。把 `resources` 插在 `lib` 之后等于加了个不起作用的条目。所以这一步把 NC home
侧按官方段序（middleware 1 → framework 3 → external 4 → NCHOME 根 5 的 ⑬⓮ → modules 7）重排了。

**`external/classes` 与 `resources` 都以「目录」身份入列**，不是收里面的 jar——这两个目录里装的就是
散 `.class`，官方那两层分别是 `classes` 层与 `resources` 层。

### 11.2 本机实测（`D:/ncc/1909home` + `C:/work/aier/EyePortal`）

```
classpath 条目 7334 个
external/classes=Some(225)   resources=Some(816)   lib/fwserver.jar=Some(827)
  ⇒ 段序正确：external 在最前，resources 早于 lib（覆盖语义成立）

hotwebs 实扫 18 个：
  aim,bqchart,ebvp,emm,eyeapp,fs,help,iwebap,lfw,ncchr,nccloud,portal,uapjs,uapsep,uapws,uui1,uui2,web
  ⇒ 改动前只挂 5 个，iwebap（NCC 主前端）与 eyeapp（业务前端）都被静默跳过

prop.xml 服务名 = xuyserver；启动参数 = -Dnc.server.name=xuyserver
work/ 下的服务器目录 = ["server"]
  ⇒ 复现了分叉：配置写 xuyserver，运行时却按默认名建了 server/。补上参数后 work/xuyserver/ 才与配置一致，
     官方 stopServer.bat（按 work/<name>/port 找端口）才能停掉我们起的服务
```

### 11.3 验证方式

- 单测 6 条（`launch.rs::tests`）：实扫 vs 写死、目录缺失回落不返回空、服务名取 `<server><name>` 且
  不被 `<service>` 段的同名标签带偏、`external/classes`/`resources` 的位置关系、无目录条目时报可读错误。
- 真机快照 `tests/launch_spec_live.rs`（`#[ignore]`，3 条），跑法：
  `cargo test --test launch_spec_live -- --ignored --nocapture --test-threads=1`，
  `NC_HOME` / `NC_WORKSPACE` 可覆盖路径。
- 门禁：`cargo fmt --check`、双 feature 的 `clippy --all-targets -D warnings` 与 `cargo test`
  全绿（348 项单测 + 14 个测试二进制，两口径一致）。

### 11.4 还没验的（必须真机启动一次）

静态验的是「参数与清单对不对」，**不是「服务能不能起、页面能不能开」**。下面三条只能启动后看：

1. **E2 的实际效果**：日志里 `ignore hotwebs webapp` 应该一条都没有了；反过来，18 个 webapp 全挂会
   增加启动时间与内存占用。若起不来或太慢，处置是收窄名单——但那时要按「业务实际用哪几个」来定，
   不能再回到写死 5 个（那 5 个里没有 `iwebap`/`eyeapp`）。
2. **E3 的实际效果**：`work/` 下应出现 `xuyserver/`，`work/xuyserver/port` 里有端口号。
3. **E5 的实际效果**：`external/classes` 里那几个 `PoOrder*Action` 二开类的改动应当生效（挑一个能观察到的）。

回滚很轻：四处改动都在 `launch.rs` / `nc_home.rs`，没有数据迁移、没有配置结构变化。

---

## 附：证据索引

| 结论 | 证据 |
|---|---|
| `-cp` 只有 4 个 jar | `bin/uapSetupCmdLine.bat:73` |
| 真实主类是 `NCStarter` | `bin/startServer.bat:15-17` |
| 8 段顺序 | `starter.jar` → `BootstrapClassLoader.java:29-44` |
| 15 层顺序 | `ClasspathComputer.java:23-65` |
| 模块判定 = `META-INF/module.xml` | `ModuleFilter.java:14-19` |
| 排序 = priority → uap → 字典序 | `ModuleComparator.java:15-30` |
| `_src.jar`/`_doc.jar` 被排除 | `JarFilter.java:12-24` |
| webapp `delegate=true` | `nc/bs/tomcat/startup/Bootstrap.java:84,90` |
| develop 分支与 `projectdir` | 同上 `:66-70` |
| `uap.hotwebs` 白名单 | 同上 `:114-153` |
| 端口三级优先级 | 同上 `:161-164` |
| 官方命令行拼装 | `nc/bs/mw/domain/ManagedServerProcess.java:307-351` |
| 服务清单来自 prop.xml | `ierp/bin/prop.xml:17-32` |
| `StartDirectServer` 只有 4 步 | `javap -c ufmiddle/start/tomcat/StartDirectServer.class` |
