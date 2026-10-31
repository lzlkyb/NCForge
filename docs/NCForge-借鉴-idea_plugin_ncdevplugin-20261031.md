# NCForge 借鉴方案：airh2o/idea_plugin_ncdevplugin

> 日期：2026-10-31　来源：`github.com/airh2o/idea_plugin_ncdevplugin`（master `be831fe`，31★/18 fork）
> 方法：稀疏克隆全量源码（`git clone --depth 1 --filter=blob:none --sparse`，只取 `src/`），
> 逐文件读核心包；NCForge 侧结论均用 grep/读码核对，不凭印象。
> 结论落点：**值得抄 7 条、明确不抄 5 条、三批落地**。

---

## 0. 一页结论

先给判断：这个插件是「**IDE 里的 NC 二开副驾**」，NCForge 是「**IDE 外的 NC 专属工作台**」。
两者只在 **M7 补丁与数据库**这一块正面重叠，而插件在那里攒了 6 年的**领域硬知识**——
硬知识指的是「不照它做，产物就是错的」那类规则，不是界面偏好。

| # | 借鉴项 | 性质 | 我们的现状 | 优先级 | 工作量 |
|---|--------|------|-----------|--------|--------|
| B4 | 数据 SQL 三条格式规则（主键前置 / blob 写 null / 多语列 `'~'`） | **缺口 0→1** | **已落地**（`sql_export.rs`） | ✅ 完成 | — |
| B3 | 从测试库抽数据生成 insert 脚本 | 缺口 0→1 | **已落地**（`db_export_insert` + 导出对话框） | ✅ 完成 | — |
| B2 | 类→模块归属「声明优先 + 三级降级」 | 体验升级 | 逐条改判已有，不持久化 | P1 | 2 天 |
| B5 | NC 库容器 12 类构成 | 核对项 | 按 import 挑 jar | P2 | 0.5 天 |
| B6 | 版本内容探测 5 条判据 | 低成本预埋 | 只判「是不是 home」 | P2 | 0.2 天 |
| ~~B7~~ | ~~NCC `yyconfig` → `WEB-INF/extend` 特判~~ | ~~条件性必须~~ | — | **不做**（团队无 NCC 前端二开） | — |
| ~~B1~~ | ~~`X_src.jar` 双产物 + `public/private/ui_` 三 jar~~ | ~~形态对齐~~ | — | **不做**（现场解压覆盖 NCHOME） | — |

**不抄**：NC 代码规范检查（空壳）、源码混淆水印（商业痕迹）、`formatSql` 的日期处理（有 bug）、
Swing 弹框范式、`printStackTrace` 日志。逐条理由见第 4 节。

**取舍已定**（2026-10-31 用户确认）：B7 不做、B1 不做、B3 要做。前两条不做之后，
**剩下的全部工作量就是 B2（2 天）+ B5/B6（0.7 天核对）**，B4/B3 已随本次改动落地。

---

## 1. 对方是什么（体量与实际完成度）

| 项 | 实测 |
|---|---|
| 自有代码 | 329 个 Java 文件 / **51,521 行**（另有 checkstyle、mstsc 第三方约 19k 行） |
| 架构 | IDEA 插件，功能全塞在 `Action → Swing Dialog → static Util` 三层，无状态机 |
| 版本覆盖 | NC5 / NC6 / NCC / BIP / U8Cloud 五代 |
| 功能数 | 补丁导出、SQL 生成合并、BMF 元数据、数据字典、Action/UPM 搜索、反编译、工程结构生成、库依赖、密码解密、MSTSC |
| 最大单文件 | `util/ObjUtil.java` **2,681 行**、`ui/PatcherDialog.java` **1,528 行**（反面教材，NCForge 有体量门禁） |

**重要**：功能列表看着吓人，但完成度不均。README 首页挂着的「NC 代码规范检查」实际是空壳
（`codecheck/NCDefualtLocalInspectionTool.java:60-80` 三个 check 全是 `return super.xxx(...)`）。
所以**不能按功能清单抄，只能按实现质量抄**——下面每条都标了「读到的实际代码」。

真正有含金量的核心只有 4.3k 行左右：
`util/exportpatcher/**`（2,054）+ `util/meta/**`（1,596）+ `nc/uap/studio/pub/db/**`（640）。

---

## 2. 能力对照矩阵

| 能力 | 插件 | NCForge（2026-10-31） | 差距性质 |
|------|------|----------------------|---------|
| 补丁 class 收集 + 层判定 | 有 | 有（`patch_build.rs::locate_layer:343`） | 持平 |
| 层判定**逐条改判** | 无（走配置文件） | **已有**（`ItemDetail.tsx:28`，自动/标准/hyext） | 已超前 |
| 层判定**规则持久化** | 有（properties 声明） | 无（改判只活到本次扫描） | **真缺口** |
| `_src.jar` 源码包 | 有 | 无（`_src.jar` 仅用于 jdt.ls 看源码） | 形态差 |
| public/private/ui 三 jar | 有 | 无 | 形态差 |
| NCC yyconfig 落位 | 有 | 无 | **条件性缺口** |
| 云管家补丁格式 | 有 | 无 | 无需求则不做 |
| SQL 合并去重 | 有（粗糙） | 有（更好，剥离字面量） | 我们更强 |
| 表数据 → insert 脚本 | 有（XML 模板） | **有**（`db_export_insert`，界面参数） | 已补齐 |
| 多语列 / blob 导出规则 | 有 | **有**（`sql_export.rs`） | 已补齐 |
| 表结构 + 主键读取 | 有（`SqlUtil.retrieveTable`） | 有（`sql_refs`） | 持平 |
| BMF 元数据 ← 数据库 | 有（映射表 9 组） | 无（三期） | 缓做 |
| 数据字典导出 | 有 | 无 | 不做 |
| 请求地址 → 类（upm/yyconfig/注解） | 有（多源合并） | 无 | 见 3.B8 附注 |
| 代码规范检查 | **空壳** | 无 | 不做 |
| 工程/运行配置生成 | 有 | 已有（`middleware_spec`） | 持平 |

---

## 3. 值得抄的七条

### B4　数据 SQL 的三条格式规则（P0，0.5 天）

**为什么最优先**：这是全仓唯一「不照做产物就错」的规则，且我们完全没有这条路（`grep "insert into" src-tauri/src` 只命中一个测试用例）。

证据：`src/nc/uap/studio/pub/db/ScriptHelper.java:73-168`（从 NC 官方 jar 反编译出来的 `convert2InsertSqls`）

```java
// ① 主键列前置并去重（:107-116 先拼所有 PK，:144 跳过重复项）
singleSql.append(table.getName()).append("(").append(sbPKColumns).append(cols)...;

// ② 二进制列直接写 null，不导内容（:147-149）
if (isBlobColumn(col)) { cols.append(columnName).append(","); values.append("null,"); }

// ③ 多语列：列名尾字符非数字时写 '~'，并跳过 col2..col6（:153-165）
char endChar = columnName.charAt(columnName.length() - 1);
if (!Character.isDigit(endChar)) {
    cols.append(columnName).append(",");
    values.append("'~'").append(",");
    multColumnList.add(columnName + "2"); ... + "6";
}
```

**多语列那条是 NC 数据模型的核心知识**：NC 的多语字段是 `name` + `name2`…`name6` 的列族
（6 个语种各一列）。导出数据时正确做法是只写 `name` 列并填 `'~'`，让 NC 运行时按语种取；
不知道这条就会把 6 列全导一遍（脏数据），或者只写 `name` 不写 `~`（多语切换失效）。
NCForge 全仓「多语」0 命中，说明这条知识目前完全不在系统里。

**落地方式**：
- 地基已经现成：`db_rust.rs:696` 的 `pk_columns()`（读 `user_constraints`/`user_cons_columns`）、
  `:623` 的 `columns()`（含 `data_type`/`data_length`）就是 B4 需要的一切，不用新建元数据查询。
- 落点应是 `sql_refs.rs` 旁边新增的 `sql_export.rs`（纯逻辑 + 单测），不要塞进现有的只读查询链路。
- 三条规则各写一个单测：`主键列排最前`、`blob列写null`、`多语列写~并跳过2..6`。
- **不抄**它的 `formatSql`（见 4.3），日期用显式 `to_date('...','YYYY-MM-DD HH24:MI:SS')`。

### B2　类→模块归属：声明优先 + 三级降级（P1，2 天）

**先纠正一个过时判断**：审查报告 M7-11 记的「手动选层 UI 没有」**已经修了**
（`ItemDetail.tsx:8-14` 注释、`:28` 的 `canForce`、`usePatchBuild.ts:80-81` 真的把 `forceHyext/forceStd` 传下去了）。
所以现在的差距不是「不能改判」，而是——**改判只活一次**：`layers` 是 PatchTab 的组件 state，
切页、重扫、下次开发同一个类，全部要重新点一遍。

插件的价值正在这里：**把归属写成规则，一次生效、长期复用**。

证据：`util/exportpatcher/searchs/AbstractContentSearchImpl.java:115-158`

```
① 全限定类名精确命中     configVO.getProperty("nc.ui.gl.AddVoucherLineAction") → "gl"
② 包路径逐级向上回退     "nc.ui.gl" → "nc.ui" → "nc"（while lastIndexOf('.')）
③ 猜：取第 3 段包名      nc.ui.pub.ButtonBar → "pub"（需 config-guessModule=true）
```

配置载体是**模块根的 `patcherconfig.properties`**（`ExportNCPatcherUtil.java:73`），
除了归属映射还带 `config-notest` / `config-exportsourcefile` / `config-compressjar` /
`config-ignoreFiles` 等开关。

**取舍**：载体不要照抄 properties 文件——NC 开发者不会为出包去手写 properties 文件。
建议：把现有 `layers` state 换成**落盘进工作区**（`.ncforge/patch-layers.json`），
键支持「全限定类名」与「包前缀」两种粒度，优先级「精确 > 前缀 > 自动判定」；
再给一个「把本次改判全部记住」的按钮——用户点过一次就再也不点第二次。
把第 ③ 条（猜第 3 段包名）**不要抄**：它本质上和我们的自动判定重复，两条猜测逻辑叠加只会更难解释。

### B7　NCC 前端补丁的 yyconfig 特判（**不做**）

证据：`util/exportpatcher/beforafter/HotwebsModuleClassBeforRule.java:63-93`

```
client 源文件路径含 /yyconfig/  → 目标 hotwebs/<module>/WEB-INF/extend/yyconfig/...
其余 client/public/private      → 目标 hotwebs/<module>/WEB-INF/classes/...
```

**结论（2026-10-31 用户确认）：团队补丁不涉及 NCC 前端二开，这条不做。**
价值只在「有 upm / yyconfig 扩展的补丁」时才成立，没有这个场景就是死代码。
留档于此：哪天开始做前端接口配置，先看 `HotwebsModuleClassBeforRule` 的这段分流。

### B1　`_src.jar` 双产物 + 三 jar 命名（**不做**）

证据：`AbstractContentSearchImpl.java:408-432`

```java
IoUtil.makeJar(dir, jarFile,    maniFest, new String[]{".java"});   // X.jar      含 class
IoUtil.makeJar(dir, jarSrcFile, maniFest, new String[]{".class"}); // X_src.jar  含源码
```

命名与来源目录（`:341-372`）：

| jar | 源目录 | 说明 |
|-----|--------|------|
| `public_<模块>.jar` | `<模块>/classes` | 服务端公共 |
| `private_<模块>.jar` | `<模块>/META-INF/classes` | 服务端私有 |
| `ui_<模块>.jar` | `<模块>/client/classes` | 客户端；**NCC/BIP 不打**（走 hotwebs） |

**结论（2026-10-31 用户确认）：现场部署就是把补丁解压覆盖到 NCHOME，不要求 jar 形态，这条不做。**
我们 `write_package:871-955` 平铺 java + class 进 zip，解压覆盖后一样生效——jar 化只是
「与 Eclipse/UAP 出包习惯一致」的形态对齐，对方那套 `X.jar` + `X_src.jar` + `public_/private_/ui_`
命名只有在「必须按 UAP 规范交付 jar」的现场才有意义。留档：真遇到要 jar 的现场再照
`AbstractContentSearchImpl.java:341-432` 的目录来源规则补。

### B3　从测试库抽数据生成 insert 脚本（已落地）

**用户已确认要这个能力**，所以它不是排期项，是本次交付物。但落地方式**不照抄 items.xml 变量体系**。

对方那套（`vo/ItemsItemVO.java:64-232`）是给「一次导出几十张关联表」准备的：`<env><schema>` 加前缀、
`<vars>` 内置 `{date}/{project}/{module}`、`<var name>` 常量、`<varBySql name join itemwarp>` 查库取一组值、
变量互引要**两轮替换**（`:126-133` 先解 `var`，`:183-189` 再解一次）。它解决的问题是
「同一个模板在开发/测试/生产三个库之间可移植」，代价是**用户得先学会写 XML**。

我们的取舍：**把变量体系换成界面参数**。

| 对方 | 我们 |
|---|---|
| `items.xml` 文件 | 导出对话框（表页 / SQL 控制台两个入口） |
| `<env><schema>` | 对话框里的 Schema 输入框 |
| `<vars>{date}` 等内置变量 | 不需要（取数语句直接写） |
| `<varBySql join itemwarp>` | 不需要（`select` 里自己 join 出来） |
| 两轮替换 | 没有变量，就没有替换 |

理由：这台工具的用户是 NC 实施/开发，不是写 XML 模板的中间件工程师。真要批量导几十张表，
一次导出就选一次表结构，比维护一份 XML 简单；而「写 20 行 XML 就能导一组关联表」的前提是
**已经有一整套变量语义要学**，这个学习成本在我们这儿换不来收益。

**实现**（`feature/db-insert-export` 这一批）：

```
sql_export.rs            纯逻辑：列计划 + 三条格式规则 + 渲染（9 个单测）
commands/db_export_cmds.rs  取数：独立会话 → exec/more 读空 → 拼装脚本与统计
components/db/InsertExportDialog.tsx  选项与落盘（表页 / SQL 控制台两个入口）
```

三个实现细节值得记下来：

1. **取数开独立会话**。`exec` 会把连接上「加载更多」的游标吃掉（`db_rust.rs:419 close_cursor`），
   复用现有句柄等于「导一次表，控制台的分页就废了」。所以优先用同一套配置另开一条会话、
   读完就断；只有手动连接且没勾「记住」时（拿不到口令）才退回复用，这是有意的降级。
2. **多语判定不用「列名末尾不是数字」**。参考实现里那句（`ScriptHelper.java:154-164`）只是
   「已判定为多语之后，认出哪一列是基础列」；真正的判定在 `isMultColumn`
   （`:176-187`，查 NC 元数据 `mlTableInfo`）。我们拿不到那份元数据，退一步用**列族存在性**：
   基础列是字符类型 + `X2`..`X6` 至少存在 3 列。宁可漏判（少写 `'~'`，数据还能用）也不误判
   （误判会丢数据），界面上把识别结果显式列出来给人核对。
3. **截断必须说出来**。行数到上限、CLOB 顶到 1MB 读取上限，都要在对话框里标红。
   静默截断比导不出来更坏——用户会拿一份「看起来完整」的脚本去生产库跑。

### B5　NC 库容器的 12 类构成（P2，0.5 天，核对为主）

证据：`util/IdeaProjectGenerateUtil.java:421-520` + `IoUtil.serach*`

```
Ant / Product_Common / Middleware / Framework
Module_Public_Extra / NC_Module_Public_Hyext(行业版) / NC_Module_Public
Module_Client_Extra / Module_Client_Hyext / Module_Client
Module_Private_Extra / Module_Private_Hyext / Module_Private
Module_Lang / Generated_EJB / hotwebs 系列
```

这和我们 M0 记录的「`.classpath` 引用 9 个 UAP 库容器」是同一套东西，插件给出了每类的实际目录规则。

**两条要核对**：
1. `hyext` / `lang` / `generated_ejb` 三类是否进了我们「按 import 挑 jar」的候选集
   （`hyext` 在 `patch_build.rs` 里有 38 处命中，说明层判定认得它，但 classpath 侧未确认）；
2. **库根不只有 jar，还有 `modules/*/{public,client,private}/classes` 目录**（`:289-300` 的 `serachAllNc*Class`）。
   我们按 jar 挑，可能漏了已编译的 classes 目录。

### B6　版本内容探测 5 条判据（P2，0.2 天）

证据：`util/ProjectNCConfigUtil.java:612-657`

```
配置 nc.version 优先
U8Cloud : webapps/u8c_web/webapps/Client/appletjar/U8C_Login.jar
NC5     : webapps/nc_web/Client/appletjar/NC_Login_v507.jar
BIP     : hotwebs/yonbip/            （目录）
NCC     : hotwebs/nccloud/           （目录）
否则    : NC6
```

我们 M1 的识别只判「是不是 NC home」（startup.bat 含 NCStarter + modules/ierp/middleware + ufjdk），
不判版本。团队现在统一 1909（NCC），所以不痛；但「多版本切换」是二期明确项，
把这 5 条写进 `env detect` 是一次性成本极低的预埋。

### B8（附注，不立项）请求地址 → 类的多源索引

`NCCActionRefreshUtil.java` 把「url → 类」从 5 个来源合并：`.upm` 文件、`yyconfig/modules` 目录、
jar 内的 yyconfig、JAX-RS `@Path`、Spring `@RequestMapping`，优先级 yyconfig > lib jar。
这是 NC 开发者「拿到一个报错 url，要找到对应类」的高频路径。

**为什么暂不立项**：我们有 jdt.ls 的类/符号搜索 + 反编译跳转，覆盖 80% 场景；
剩下 20%（只有 url 没有类名）成本不低（要解析 upm XML + jar 内配置 + 注解三套格式）。
建议等有人真的为此骂过一次再排期。

---

## 4. 明确不抄的五条

### 4.1　NC 代码规范检查——空壳
`codecheck/NCDefualtLocalInspectionTool.java:60-80`：`checkMethod` / `checkClass` / `checkField`
全是 `return super.xxx(...)`，即 IDEA 默认实现，没有任何 NC 规则。
README 里写的「检查 client/private/public 导包错误」在代码里不存在。
**产品点成立（导包层级违规确实是 NC 常见事故），但实现是 0，抄不到东西。** 我们要做就自己写规则。

### 4.2　源码混淆水印——商业痕迹
`ExportNCPatcherUtil.java:216-269` 的 `reWriteSourceFile`：往交付的 `.java` / `.js` 尾部
追加 30~230 行 `QQ:209308343@qq.com 微信:yongyourj 时间:... 文件原始MD5:...`。
这是作者的引流水印，不是工程实践。**我们的补丁包绝不能带这种东西。**

### 4.3　`formatSql` 的日期处理——有 bug
`SqlUtil.java:305-317`：`obj.toString().trim()` 直接拼进 SQL。Oracle `DATE` 经 JDBC 出来是
`2023-10-19 12:13:45.0`，裸拼进 insert 会因 `.0` 报 ORA-01830。
**我们做 B4 时必须显式写成 `to_date('...','YYYY-MM-DD HH24:MI:SS')` 或 `timestamp '...'`。**

### 4.4　Swing 弹框 + 静态工具类范式
`ui/PatcherDialog.java:1,528` 行一个对话框，全部状态靠字段；
并发保护只有一句字符串拦截（「上一次导出任务还未处理完，请稍后再试」）；
`util/ObjUtil.java` 2,681 行。
我们的单飞闸 + 取消标志 + 进度事件 + 状态机是更好的形态，别往回退。

### 4.5　`e.printStackTrace()` + 自建日志窗口
全仓散落几十处 `printStackTrace()`，错误信息进不了结构化通道，只能人肉看 IDE 控制台。
我们已有 toast / notes / 结构化错误，保持。

**另外不做**：云管家补丁格式（`AutoGenerPathcherInfo4YunGuanJiaUtil` 397 行，只在确实要交云管家时才有价值）、
数据字典导出（本质是一组 iuap 系统表查询模板，强绑定 BIP/NCC 表结构，通用性差）、
BMF 元数据反向工程（9 组「数据库字段 ↔ bmf 标签」映射表，成本高，三期再说）。

---

## 5. 落地路线

### 已交付（2026-10-31）
1. **B4 三条 SQL 规则** → `sql_export.rs`（纯逻辑，9 个单测，主键/多语两条已做「改坏必变红」验证）。
2. **B3 抽数导 insert** → `commands/db_export_cmds.rs`（`db_export_insert`）+ `InsertExportDialog`，
   入口挂在表页与 SQL 控制台。取数走独立会话，读完即断。

### 剩余唯一一项 P1
3. **B2 归属规则持久化** → 现有逐条改判只差「记住」：`layers` 落 `.ncforge/patch-layers.json`，
   扫描时按「精确 > 前缀 > 自动」读；再加一个「全部记住」按钮。**不引入新的手工文件格式。**

### P2（按需，不排期）
4. B5 库容器核对（重点是「库根不只有 jar」与 hyext/lang/generated_ejb 是否进了候选集）→ B6 版本判据。

**门禁**（沿用既有口径，不放宽）：
- Rust 双 feature：`clippy --all-targets -D warnings` + `cargo test`；
- 前端五步：check-component-size / eslint / tsc / vitest / vite build；
- B4 的三条规则各有单测，且**已实测「改坏实现会红」**（`guard-test-must-go-red`）；
- B4/B3 的产物（.sql）必须在真实 NC 库上跑一次：拿测试库导出、在另一个库回放，
  核对多语列与日期。**只跑单测不算验收**。

---

## 6. 三个前提的结论（2026-10-31 用户答复）

| 问题 | 答复 | 影响 |
|---|---|---|
| 团队补丁是否包含 NCC 前端二开 | **不包含** | B7 不做 |
| 现场部署是解压覆盖还是必须 jar | **解压覆盖** | B1 不做 |
| 是否需要从测试库抽数据生成 insert | **需要** | B3 已落地 |

**没有遗留待确认项。** 下一步只有 B2（2 天），其余按 P2 按需。

---

## 附：证据索引

| 结论 | 文件:行 |
|------|---------|
| 多语列 / blob / 主键前置 | `src/nc/uap/studio/pub/db/ScriptHelper.java:73-168` |
| 日期格式化缺陷 | `src/nc/uap/studio/pub/db/SqlUtil.java:305-317` |
| 三级降级归属 | `src/com/air/nc5dev/util/exportpatcher/searchs/AbstractContentSearchImpl.java:115-158` |
| 三 jar + `_src.jar` | 同上 `:341-432` |
| 模块配置文件名 | `src/com/air/nc5dev/util/ExportNCPatcherUtil.java:73` |
| SQL 合并（按 go/; 切分去重） | 同上 `:659-690` |
| yyconfig 落位 | `src/com/air/nc5dev/util/exportpatcher/beforafter/HotwebsModuleClassBeforRule.java:63-93` |
| items.xml 变量体系 | `src/com/air/nc5dev/vo/ItemsItemVO.java:64-232` |
| 库容器 12 类 | `src/com/air/nc5dev/util/IdeaProjectGenerateUtil.java:421-520` |
| 版本判据 | `src/com/air/nc5dev/util/ProjectNCConfigUtil.java:612-657` |
| 代码检查空壳 | `src/com/air/nc5dev/codecheck/NCDefualtLocalInspectionTool.java:60-80` |
| 混淆水印 | `src/com/air/nc5dev/util/ExportNCPatcherUtil.java:216-269` |
| 请求索引多源合并 | `src/com/air/nc5dev/util/NCCActionRefreshUtil.java:97-135,373-453,627-731` |
