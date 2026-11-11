# jar 内代码搜索：行业对标实测与分阶段方案（v2）

> 2026-11-10 立项，**2026-11-11 批次 A 已实施并全量验收**（实测数据见 §3.8）。
> 用户原话：「我们现在的搜索能区分是工作区，还是 jar 包里面的代码吗」→「行业软件都可以做到这个我们要对齐能力，规划一下」→「我们现在本机的 eclipse 就能搜索 jar 里面的类，还是秒级别出来的你看他怎么做的」→「开工，之前规划代码里面中文和代码字符级别搜索一起做了」。
>
> **批次 A 落地文件**：`class_pool.rs`（常量池解析）/ `jar_symbols.rs`（索引+检索）/ `commands/jar_symbol_cmds.rs`（命令）/ `lib/jarSymbolSearch.ts` + `components/search/JarSymbolResults.tsx`（前端第四档）。`decompile.rs::run_cfr` 的 `--hideutf false` 一并修掉。

---

## 0. v1 → v2 变更说明（先读这段）

**v1 的核心前提被自己的实测推翻，故全文重写。**

| v1 的判断 | 实测结论 | 影响 |
|---|---|---|
| jar 全文唯一路径是 CFR 反编译全量产物，6480 jar ≈ 80 分钟，因此批次 B 成本极高、批次 A 只能做类名补齐 | class 常量池可**纯字节解析、无 JVM**：120 个 jar 1.22 秒出 13065 个 class / 894566 条符号，外推全量 6480 jar ≈ **66 秒**；且中文字符串取到的是**原文**，不是转义 | 反编译从「搜索数据源」降级为「查看态」；批次 A 一步拿到 Eclipse 同级覆盖，不需要等批次 B |
| v1 未验证「Eclipse 索引到底含什么」 | 本机 Eclipse 索引实测含条目路径 / 类名 / 包名 / 字段名 / 常量名 / 引用类型，**抽样中未见方法名**（§1） | 我们加常量池层后**方法名也能搜**，这是真实超出 Eclipse 的一点 |
| v1 引用 CFR 时未标 `--hideutf false` | CFR 0.152 默认 `--hideutf true`，非 ASCII 全转 `\uXXXX`；`run_cfr`（`decompile.rs:143`）当前没传该参数 ⇒ **现有反编译查看的中文一直是转义** | 这是一个独立于本方案的真实缺陷，建议单独先修（§6 决策三） |

**v2 的净结论**：jar 内代码搜索不需要「反编译全量」这种重方案，也不需要等一个庞大的批次 B。一次中等批量的实现（常量池符号层）就能同时对齐 Eclipse 的符号覆盖、并拿到中文串可搜。

**v2.1 补记（2026-11-11）**：批次 A 落地后又补了 §3.9——「注释不可搜」这个判断本身被推翻了一半。class 文件确实不含注释，但 NC 随包发布的 `_src.jar` 一直在 `modules` 下（2775 个 / 21.4 万个 `.java`），注释由此可搜、可点开。同批把「代码与文件里的中文」（GBK）也修了（`workspace.rs` 编码探测判据，另见 `content_pack.rs` `FORMAT_VERSION` 2→3）。

---

## 1. 本机 Eclipse 怎么做到秒级（解剖结论）

解剖对象：`D:\NC65\nc65newwork\.metadata\.plugins\org.eclipse.jdt.core\`

| 观测项 | 数值 |
|---|---|
| `.index` 文件数 | **5502** |
| 索引总大小 | **345 MB** |
| `savedIndexNames.txt`（索引清单） | 92 KB |

**索引里有什么**（抽样 5 类内容，逐条可复核）：

1. **条目路径**——jar 内 class 的完整路径（`nc/impl/dao/BaseDAO.class` 这种形态）
2. **类名**——含内部类，Eclipse 用 `Outer$Inner` 记法
3. **包名**——`nc.pub.impl.dao` 这种分段
4. **字段名 / 常量名**
5. **引用类型**——该类 import / new / 强转 到的其他类型

**🔴 抽样中未见方法名。** 这条对本方案有直接价值：常量池里 `Methodref` 的 `NameAndType` 是完整可解析的，我们把方法名收进来，符号覆盖就**严格超过**本机这份 Eclipse 索引。

**机制本质**：查询时**不扫 jar**，只查索引文件。345MB 换秒级，是空间换时间的老办法——但对我们是好消息：我们不需要重新发明机制，只需要把「已有的类名索引」扩展成「常量池符号索引」，查询侧复用同一套倒排。

**三条启示**：
1. 预建索引是行业唯一解，没有"现扫现出"的魔法。
2. 345MB / 6480 jar ≈ 每 jar 53KB，这个量级在桌面端完全可接受 ⇒ 索引体积预算建议 ≤500MB（§6 决策二）。
3. Eclipse 都只做到「符号 + 引用」，**没有任何一家做 jar 全文**（IDEA 官方帖明确 `.class` 不建 word 索引；Eclipse issue #17「全文搜索加 referenced libraries 作用域」2023 年开到至今未完成）。所以"对齐行业"的目标就是符号级，不是全文级——这一点必须在交付时对用户讲清，否则会被当成没做完。

---

## 2. class 常量池探针：能拿到什么、拿不到什么

### 2.1 解析原理与成本

class 文件常量池是定长表项的二进制结构，**不需要 JVM**，纯字节读取即可。两个已实测的成本数据：

| 场景 | 耗时 | 产出 |
|---|---|---|
| 单 jar（`pubuapbd_aassign.jar`） | **1.4 ms** | 8 个 class |
| 120 个 jar 采样 | **1.22 s** | 13065 个 class / **894566 条符号** |
| 外推全量 6480 jar | **≈ 66 s** | — |

> 探针脚本在 `target/test-tmp/cp_probe.py`（纯 Python 标准库，可复跑）。采样用的 120 个 jar 覆盖 NC 各模块，不是单模块特例。

**关键结论：比 v1 估的 CFR 方案便宜约 80 倍，且中文是原文。**

### 2.2 拿得到的六类符号

| 类别 | 来源常量池项 | 价值 |
|---|---|---|
| 类名 + 内部类 | `Class` / `Utf8` | 已有 TypeCatalog，本层是补齐 |
| 包名 | 类名切分 | 按包浏览 |
| 字段名 | `Fieldref` 的 name | Eclipse 有 |
| 常量名 | `String` 字面量 | Eclipse 有 |
| 方法名 | `Methodref` / `InterfaceMethodref` 的 name | **Eclipse 抽样没有 ⇒ 我们超出** |
| 引用类型 | `Class` 项的二进制名 | 跳转依赖 |
| **中文字符串原文** | `String` 常量 | **这是本方案最大的意外收获** |

中文字符串实测可读且完整，例：
- `根据VO全路径类型没有查到相应的元数据…`
- `查询系统模板失败！`
- `数据源ID重复`

⇒ 现场最常见的搜法「搜报错文案 / 搜提示语 / 搜字典项」直接可用，**这条连 Eclipse 都做不到**（Eclipse 索引不含字符串字面量内容）。

### 2.3 拿不到的两类（必须提前讲清，不是缺陷）

1. **注释**。class 文件**物理上不含注释**——javac 编译时剥离。jar 里搜"中文注释"必然 0 命中，这是语言与文件格式的决定，不是实现问题。UI 必须常驻说明（§3.6）。
2. **局部变量名**。仅在 `-g` 编译时写 `LocalVariableTable`，NC 发布 jar 一般不帶；且即使带了也不该进索引（噪声大）。

### 2.4 CFR 0.152 四项实测行为（供批次 B 与缺陷修复引用）

| 行为 | 实测 |
|---|---|
| `--outputdir` | 支持，一次 JVM 出整 jar 全部类 |
| 单 jar 耗时 | **743 ms 含 JVM 冷启动**（比逐类调用划算得多） |
| `--hideutf` 默认值 | **`true`** ⇒ 非 ASCII 全转 `\uXXXX` |
| `--hideutf false` | 还原中文原文 |

---

## 3. 批次 A：常量池符号层（本次拟实施范围）

**目标一句话**：让 SearchTab 能搜 jar 内的类名 / 包名 / 字段名 / 常量名 / **方法名** / **中文字符串原文**，并在结果里标明来源。

### 3.1 落点（全部 file:line 可复核）

| 现有资产 | 位置 | 批次 A 做什么 |
|---|---|---|
| 类名索引 `TypeCatalog` | `java_types.rs` | 扩展为常量池符号索引：jar 指纹增量机制**原样复用**，只是把"读中央目录取类名"升级为"再解一层常量池" |
| 类名搜索命令 | `type_search_cmds.rs:64` `search_types` | 返回结构加符号层字段；现有 `workspace`/`jars` 两组**不动**，避免打断编辑器补全链路 |
| 全文搜索 | `search.rs:39` `SKIP_EXTS` | 🔴 **不删 jar/class 项**。索引层单独走，全文扫描仍跳过二进制，避免把 6480 jar 塞进磁盘扫描 |
| 反编译 | `decompile.rs:108` `run_cfr` | 仅修 `--hideutf false`（§3.7），逻辑不动 |

### 3.2 索引格式

- **紧凑二进制分片**，不沿用 TypeCatalog 的 JSON 缓存：JSON 存 894566 条符号体积与解析都难看；二进制分片可按 jar 分片、增量只重建变动 jar。
- **倒排结构**：`词 → Vec<(jar_id, entry_id)>`，按需加载分片，**不全量载入内存**（Eclipse 345MB 全载会直接吃爆前端进程）。
- **必须加缓存版本号 +1**：旧 `type-index` 缓存与新格式不兼容（同 `content_pack` `FORMAT_VERSION` 2→3 的处理逻辑）。

### 3.3 噪声过滤（不做会把索引撑爆）

常量池里混着大量编译器结构名，必须过滤：
- `Code`、`LineNumberTable`、`LocalVariableTable`、`SourceFile`、`StackMapTable`、`Signature`、`InnerClasses`、`BootstrapMethods`、`MethodParameters`、`RuntimeVisibleAnnotations` 等属性名
- 单字符词、纯数字、Java 关键字（`if`/`for`/`this` 等）
- 过长词（>128 字符）截断丢弃

### 3.4 前端

- SearchTab 增加**第四档「依赖 jar」**，与现有 `workspace` / `jars`（类名）分列，来源一眼可辨。
- 2026-11-11 续增**第五档「jar 内注释」**（来源 `_src.jar`），见 §3.9。
- `SearchHit` 增加 `source: { kind, jar?, entry? }`，命中 jar 时显示 jar 名 + 类条目。
- 点击命中 → 反编译查看（复用现有 `decompile_cmds.rs:178` 链路，批次 A 只补跳转参数）。

### 3.5 并发与性能

- 建索引走 `spawn_blocking`，与 `search_types` 现有模式一致（`type_search_cmds.rs:84`）。
- 建索引期间返回「正在建」，不阻塞输入框（`type_search_cmds.rs:90` 已有 `indexing` 语义可复用）。
- 建索引一次性 66 秒，**只在 jar 清单/指纹变化时触发**，不做定时重建。

### 3.6 常驻说明（防「搜不到就是没做」）

jar 符号段 UI 固定一行：**「jar 内可搜：类名、包名、字段、常量、方法名、字符串文案。」**

源码注释段（§3.9）另有一行：**「来自 NC 随包发布的 `_src.jar` 源码。class 文件不含注释，所以这段是 jar 内注释的唯一来源；点开是原始源码。」**

🔴 「注释不可搜」这句话在 3.9 落地后**已不成立**（2026-11-11）：`modules` 下 2775 个
`_src.jar` 里有 214,159 个 `.java`，注释已可搜、可点开。class 文件不含注释仍是真的，
但「NC 的 jar 里没有注释」是假的——源码包一直在安装目录里，只是此前没人去读它。

### 3.7 顺带修 `--hideutf false`

`run_cfr`（`decompile.rs:143`）补 `--hideutf` `false`。这是独立缺陷，影响现有反编译查看体验，与批次 A 无依赖，可单独先提（§6 决策三）。

### 3.8 验收判据（可执行，不靠"看起来对"）

2026-11-11 全量实测（本机 3341 jar / 280,926 class / debug 与 release 各跑一遍）：

| # | 判据 | 通过标准 | 实测 | 结论 |
|---|---|---|---|---|
| 1 | 全量建索引耗时 | ≤ 3 分钟 | **102 s**（debug；release 未测，同规模只快不慢） | ✅ |
| 2 | 单词搜索响应 | ≤ 200 ms | release **4~124 ms** / debug 3~226 ms | ✅ |
| 3 | 索引体积 | ≤ 500 MB | **96 MB** | ✅ |
| 4 | 搜 `VoucherBillOrder` | 命中，且标出所在 jar | 🔴 **NC65 里没有这个类**（jar 中央目录 0 条，NC6 时代的名）→ 改用 `ArapTempVoucherVO` / `VoucherValidator` / `PrayBillOrderNumFetchDataProviderStrategy`，全部命中且标出 jar+类 | ✅（换词） |
| 5 | 搜 `数据源ID重复` | 命中（中文字符串原文） | 命中 `nc.vo.trade.report.datasource.ReportDataSourcePool` | ✅ |
| 6 | 搜 `查询系统模板失败` | 命中 | 命中 `nc.uap.bd.util.TempletValueLoader`（原文 `查询系统模板失败！`） | ✅ |
| 7 | `SKIP_EXTS` 仍排除 jar/class | 全文扫描的 jar 候选数不升 | `search.rs` 的 `SKIP_EXTS` 一行未动，索引层完全独立 | ✅ |
| 8 | 编辑器补全不回归 | `search_types` 两组结果与改动前一致 | `type_search_cmds.rs` 一行未动；新增的是独立命令 `search_jar_symbols` | ✅ |
| 9 | 畸形 class 不崩 | 索引跳过 + 记日志，进程不挂 | 真实 class **9637 个 0 失败**（平均每类 39.6 词）；另有 6 类手搓畸形单测 | ✅ |
| 10 | 增量生效 | 单 jar 改动后只重建该 jar 分片 | ⚠️ **未做分片**：`stale()` 只做「 jar 变了就整体重建」的检测，重建仍是全量 102s | ❌ 见下 |

**判据 10 的偏差（如实记录）**：方案设计了「按 jar 分片、增量只重建变动 jar」，实现落在
单文件 `symbols.bin` 上——每次 jar 变动都全量重建。理由：① 全量 102s 在后台跑、
不阻塞用户（`spawn_build` + `BUILDING` 在飞标记）；② 分片要多管 N 个文件的生命周期
与「部分分片缺失时能否出结果」，复杂度远高于收益；③ NC 环境的 jar 清单在一次开发
会话里基本不动。若现场出现「改一个 jar 就要重等 102s」的实锤，再按 `jar_fp` 逐项
比分片重建。

**两个实测中才发现的问题（都已修）**：

1. **词表比预期大 47%**：1,391,862 → **2,039,174** 词。原因是常量池里的类名是
   internal form（`nc/vo/VoucherBillOrder`），初版 `keep()` 只允许字母数字，把
   `/` 挡在门外——等于把所有类名都滤掉了。放行 `/` 与 `.`（并用 `;` 挡掉 JVM 描述符
   `Ljava/lang/String;`）后词数翻倍，索引仍只有 96MB。
2. **搜索锚字节**：首字节 `a` 在 20MB 英文词表里有上百万个候选，`ArapTempVoucherVO`
   实测 501ms 且**触发超时截断丢结果**。改为「挑 needle 里频率最低的字节当锚」
   （`load` 时现算 256 字节频率表，不进文件）后降到 142ms，release 81ms。
   附带一个免费快速失败：needle 里只要有一个字节在词表里没出现过，直接回空。

### 3.9 批次 A 续：jar 内源码注释（`_src.jar`，2026-11-11 落地）

**为什么单独立节**：§2.3 与 §3.6 原判「注释不可搜」只对一半——class 文件确实不含注释（javac 剥离），但 NC 的 `modules` 下**随包发布 `_src.jar`**：与编译 jar 同目录同名（去掉 `_src` 后缀），里面就是 `.java` 原文。此前没人读它，不是因为难，是因为没人数过。

**规模实测**（本机 `D:\ncc\1909home`）：

| 项 | 实测 |
|---|---|
| `modules` 下 jar 总数 | 6469 |
| 其中 `_src.jar` | **2775**（99.9% 与编译 jar 配对，2 个孤儿） |
| `.java` 总数 | **214,159** |
| 源码总大小 | 1020 MB（磁盘 1117 MB） |
| src jar 内压缩方式 | **全部 STORED**（压缩比 1.000）⇒ 可零拷贝读 |

**落点**：

| 层 | 文件 | 做什么 |
|---|---|---|
| 注释提取 | `java_comments.rs` | 四态扫描器（Code/Line/Block + 字符串/字符字面量跳过），块注释去每行 `*` 前缀，多行拼一行；`source_jars()` 递归枚举 `*_src.jar` |
| 索引 | `src_notes.rs` | 单文件 `NSRC`（HEADER 64B + 9 段偏移表），`Sink::feed` 可测；`search` 复用 §3.8 的锚字节 + `memchr2` + 免费快速失败 |
| 命令层 | `commands/src_note_cmds.rs` | `search_src_notes`（三态契约同 jar 符号）+ `spawn_prewarm_src_notes`（启动预热）+ `read_src_file` |
| 前端 | `lib/srcNoteSearch.ts`、`components/search/SrcNoteResults.tsx` | SearchTab **第五档**，自订阅 searchStore、自取数 |

**点开的直读通道**（本节最容易踩的坑）：`_src.jar` 被 `is_runtime_archive`
**有意排除**在 classpath 外（源码不是字节码），jdt.ls 与 CFR 的 jar 候选里都没有它
⇒ 「点开命中」不能复用反编译链路。`read_src_file` 直接从 zip 读对应 `.java`：
不起 JVM、拿到的是带注释的原文（比 CFR 更真也更快）。URI 的 jar 段是 `*_src.jar`
时先走它；读不到（组件卸载、条目缺失）才落回 jdt.ls / CFR 兜底。

**验收实测**（2026-11-11，release 探针全量跑）：

| # | 判据 | 通过标准 | 实测 | 结论 |
|---|---|---|---|---|
| 1 | 全量建索引耗时 | ≤ 3 分钟 | **101.8 s**（2775 个源码包 / 21.4 万个 .java） | ✅ |
| 2 | 索引体积 | ≤ 500 MB | **227 MB**（抽样注释占比 22% ⇒ 预估 224MB，吻合） | ✅ |
| 3 | 载入 + stale 判定 | ≤ 1 s | 载入 **309 ms** / stale **173 ms** | ✅ |
| 4 | 中文注释搜索 | ≤ 200 ms | 「凭证」**1.3 ms**、「升级」50.7 µs、「TODO」20.8 µs | ✅ |
| 5 | 命中质量 | 搜到的是注释原文 | `nc.pub.ba.update.BAPUpdateDB#L53 61升级63，部分功能节点编码从8001变为8004`——正是 §2.3 实测「class 常量池里 0 条注释」的那条 | ✅ |
| 6 | GBK 源码 | 中文注释不乱码 | `Sink` 与 `read_src_file` 走同一 `workspace::decode_lossy`；`gbk_源码里的中文注释能搜到` 单测 | ✅ |
| 7 | 点开看到带注释源码 | 不起 JVM 拿到原文 | `read_src_file` 单测（按文件名忽略大小写 + 中文注释原样带回） | ✅ |
| 8 | 三态契约 | building / stale / 就绪 | 同 jar 符号（`search_src_notes` 与 `search_jar_symbols` 同构） | ✅ |

**已知边界**：① 与 §3.8 判据 10 同理，没做分片，jar 变动整体重建（101.8s 后台跑）；② 2 个孤儿 src jar 无编译 jar 对应，点开走 `_src.jar` 直读（正好覆盖）；③ NC home 卸载后索引 stale，命中可出但点开会落到兜底链路报「组件已卸载」。

---

## 4. 批次 B 降级：反编译只服务查看

**v1 把反编译当搜索数据源，v2 推翻。** 反编译产物（CFR `--outputdir`）在本方案中**只用于"点开看源码"**，不进索引、不做全文。

保留批次 B 的唯一场景：用户要求"连 jar 里的逻辑注释都要能看"，那就只能反编译 + 人读。这不是搜索能力问题，是 class 格式的物理边界。

---

## 5. 风险与对策

| 风险 | 量级 | 对策 |
|---|---|---|
| 索引体积超预算 | 原始 894566 条符号/120 jar，全量约 4800 万条 | 分片 + 只存倒排不存原文 + 3.3 噪声过滤；上线后实测，超 500MB 再议（§6 决策二） |
| 内存 | 若一次性载入全量倒排，桌面端吃爆 | 按需加载分片；查询路径设上限（如单次最多载 N 片） |
| 畸形 / 加密 class | NC 部分 jar 可能有非标准结构 | 解析失败即跳过该条目并计数，绝不 panic；异常 jar 清单可见 |
| 旧缓存不兼容 | `type-index` 目录已有 JSON 缓存 | 版本号 +1，旧目录整体作废重建 |
| 遍历 6480 jar 本身耗时 | 光列 jar 就要时间 | 复用现有 jar 清单（`jar_catalog`），不重新遍历 |
| 「搜不到注释」被当成缺陷 | 高概率发生 | 3.6 常驻说明 + 交付时口头讲清 class 文件物理边界 |
| 与他人并发改动冲突 | 工作树常混改动 | 只挑本方案文件，按 hash-object + update-index 自建 blob 分笔提交 |

---

## 6. 待用户决策的三件事

1. **批次 A 是否开工。** 我的建议：**开工**。一批同时对齐 Eclipse 符号覆盖 + 拿到中文串可搜（后者连 Eclipse 都没有），66 秒建索引的成本完全可接受。
2. **索引体积预算定多少。** 建议 **≤ 500 MB**（与本机 Eclipse 345MB 同档）。若现场磁盘紧张可压到 300MB，代价是要更激进的噪声过滤。
3. **`run_cfr` 的 `--hideutf false` 是否单独先提一笔。** 它与批次 A 无依赖，但影响现有反编译查看体验（中文现在是 `\uXXXX`），属于"顺手能修的确定缺陷"。

---

## 附：本方案的证据链

| 结论 | 证据 |
|---|---|
| Eclipse 预建索引、345MB | `D:\NC65\nc65newwork\.metadata\.plugins\org.eclipse.jdt.core\` 5502 个 `.index` |
| 常量池解析 66 秒可完成 | `target/test-tmp/cp_probe.py`，120 jar 1.22s / 13065 class / 894566 符号 |
| 中文字符串可读 | 同上探针，输出 `数据源ID重复` 等原文 |
| CFR `--hideutf` 默认 true | CFR 0.152 实测，`run_cfr` 无该参数（`decompile.rs:143`） |
| 全文搜索跳过 jar | `search.rs:39` `SKIP_EXTS`、`search.rs:1870` |
| 类名级已区分来源 | `type_search_cmds.rs:64` 返回 `workspace`/`jars` 两组，`type_search_cmds.rs:101` 同名去重 |
