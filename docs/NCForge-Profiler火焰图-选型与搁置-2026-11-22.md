# NCForge Profiler 火焰图 — 选型结论与搁置记录（2026-11-22）

> **状态：暂缓，不是否决。** 2026-11-22 用户拍板「先不做，后面再说」。
> 重开条件见 §5。本文件是选型结论的真源，**不要重新推演**——除非 §4 的前提被实测推翻。

## 1. 为什么暂缓

- 没有明确的痛点驱动：用户近半年未遇到「手工加日志计时还抠不出来」的性能问题。
- 仓库当时压着四摊他人在途工作流（search/content_pack、SQL、ECJ/binding、storage），此时开无痛点驱动的新功能风险大于收益。
- 替代手段现成且免费：VisualVM 能附着中间件采样；JProfiler / IDEA Ultimate 更完整。内置的**唯一真正差异化是热替换闭环**（§6），不是采样质量。

## 2. 现状勘察结论（2026-11-22 实证）

| 事实 | 证据 |
| --- | --- |
| 全库无任何 profiler / JFR / 火焰图代码 | grep `profil\|flame\|jfr\|async-profiler\|jcmd\|jstack` 只命中 `GenProfile`（BMF 代码风格配置，与性能剖析无关） |
| 中间件 JVM 由本应用 spawn，命令行可控 | `commands/server_cmds.rs::server_start` 自拼 java 命令行（classpath 清单 + `-Xmx`） |
| 已有 `-javaagent` 注入先例 | `hotswap.rs::launch_agent_arg` / `launch_agent_arg_for`，热替换 agent 就走这条路 |
| 已有「调 java 子进程 + GBK 解码」先例 | `java_run.rs::execute` / `reader` / `complete_prefix_len` |
| PID 可获得 | `server_cmds.rs::server_kill_port_owner`（按端口找 java 进程，且只杀 `java*`） |
| 前端零图表库 | `package.json` 共 25 个依赖，无 chart/d3/echart/visx/flame ⇒ 火焰图必须手写 SVG |

## 3. 决定性约束：NC 自带 JDK 是 1.8

- JDK 位置 `<nc_home>/ufjdk/bin/java.exe`（`bind_resolver.rs`、`compile.rs`、`bmf_publish.rs` 多处引用）。
- 版本证据：`compile.rs` / `build_state.rs` 用 `-1.8` 编译目标；`bmf_publish.rs` 注释明写「官方发布工具依赖 1.8；用系统 JDK 可能报 UnsupportedClassVersion」。
- **后果：JFR（Java Flight Recorder）在 JDK 8 上是商业特性（需 `-XX:+UnlockCommercialFeatures`），OpenJDK 8 构建基本不含 ⇒ 方案 C 直接排除。**

## 4. 三方案对比（含工期）

工期均含本项目固定成本（命令契约三件套 + `gen-command-contract`、AppError 契约、单测、体量/令牌棘轮）——约占三成，躲不掉。

| | A · jstack/jcmd 采样 | B · async-profiler | C · JFR |
| --- | --- | --- | --- |
| 工期 | **~2 周** | ~3.5–4.5 周 | 排除 |
| 保真度 | 中低 | 高（工业标准） | — |
| 新增依赖 | 零 | 原生库打包（`resources:pack` 改造） | — |
| 主要风险 | 采样失真（见下） | Windows 原生库二等公民；运行中 attach 权限 | JDK 8 不可用 |
| 后端要点 | `jstack <pid>` / `jcmd <pid> Thread.print` 周期采样 → 解析线程块 → 聚合折叠栈树 | `-agentpath` 注入（复用 hotswap 先例）→ collapsed/JFR 输出 → 火焰树 | — |

**方案 A 的保真度天花板（必须写在方案里，别自欺）**：
`jstack` / `jcmd Thread.print` 只在**安全点**打印，且打印瞬间 JVM 停顿。
⇒ 采不到安全点之间的 CPU 忙循环；测出的占比被 jstack 自身耗时扭曲。
对「哪个 NC 业务方法热」通常够用；对「这个循环为什么吃满一个核」会漏。

**前端固定工作量（A/B 都要付）**：火焰图组件手写 SVG（矩形 + 缩放 + hover + 搜索 + 导出折叠栈），约 250–300 行 + 交互测试。项目零图表库，躲不掉。

## 5. 两期路线与重开条件

- **第一期（~2 周）**：方案 A，只做中间件一个目标（服务抽屉 + Java 运行面板），先把「看得见」落地。
- **第二期（条件触发）**：仅当第一期在真实场景实测发现安全点偏差确实漏了关键栈，才叠加方案 B。
  **第一期的栈解析、聚合、前端火焰图在第二期全部复用**，不重复建设。

**重开条件（满足其一才立项）**：
1. 用户真撞到一次「手工加日志计时还抠不出来」的性能问题——这是唯一的产品级触发条件；
2. 或者用户明确要求「不管有没有痛点，先做出来备着」。

**开工前必须先实测的前提**：`<nc_home>/ufjdk/bin/java.exe -version`。
若实测是 11+，**方案 C 立即复活，本文件 §3/§4 的选型结论整体作废重写**。

## 6. 它真正的价值（与差异化边界）

**值**：把「卡在哪」的定位从「离开工具 → 外部 profiler → 手动找进程/挑线程 → 回 IDE 改 → 回本工具热替换」的跨三工具循环，压成抽屉里一个按钮的闭环；且与热替换咬合——改完即验证，**中间件不重启**（NC 中间件重启一次几分钟且丢登录态）。
附带价值：火焰图能直接判定「慢在框架通用路径还是自己的 hotwebs 模块」，是该背的锅改、不该背的锅不背的证据。

**不值（别为这些做）**：
- 慢在 SQL——CPU 采样只看到线程卡在 JDBC 调用，看不出 SQL 文本；那是执行计划的事。
- GC 停顿 / 内存泄漏——那是 GC 日志 / 堆转储分析，另一个功能。
- 用户已是 JProfiler / IDEA Ultimate 重度用户且不介意切窗——边际价值只剩闭环。
