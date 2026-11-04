# 借鉴 Eclipse 行业插件（eclipsehy）能力迁移方案

> 2026-11-04。现场：`D:\tool\eclipsehy`（用友 NC65 行业开发版 IDE），31 个用友自研插件 + 3 个第三方。
> 本文只回答一件事：**这些插件里哪些能力值得搬进 NCForge，怎么搬**。

---

## 0. 结论先行

31 个插件扫完，真正「NCForge 没有 + 有实际价值 + 能在 Rust 侧独立实现」的只有 **4 块**：

| # | 能力 | Eclipse 出处 | 现在的 NCForge | 价值 | 建议 |
|---|---|---|---|---|---|
| A | **UPM 装配索引**（接口 ↔ 实现 / remote / tx / 模块归属） | `com.yonyou.uap.upm`、`nc.uap.mde`（Open Declaration / Search Upm Resource） | 只做**部署**（`nchome_deploy.rs`），不解析 | 找实现类不再靠全局搜；装配漏写/写错类名能提前报 | **P0，先做** |
| B | **元数据 bmf/bpf 索引**（表 → VO 类、单据按钮 → 实现类） | `NCMDP`（MDP Explorer、业务操作视图） | 无。数据字典的实体列来自库里 `md_ormap`，不连库就没有 | 离线也能查「这张表对应哪个类」「这个按钮是哪个类」 | **P1** |
| C | **多语资源查询**（lang key ↔ 中文字面量） | `NCPlugin` 的「外部化多语资源 / 修改多语资源」 | 无（数据库侧的多语列处理是另一回事） | 二开加中文不再重复造 key、不再翻译不一致 | **P1（先只读）** |
| D | **模块依赖检查**（`component.xml` 声明 vs 实际 import） | `com.yonyou.uapstudio.build.check` | 无（`compile_diag` 查的是产物过期，不是依赖） | 少一类「本地能编、部署后 `ClassNotFound`」 | P2 |

其余 20 多个插件是 Eclipse 平台耦合（SWT 视图、nature/builder、向导）或已过时的 RIA 体系，**搬过来是重造 IDE，不是补能力**。逐条判定见 §2。

---

## 1. 现场盘点

```
D:\tool\eclipsehy\               Eclipse 4.11 (2019-03) + jdk1.8
├─ yonyouplugins\plugins\        31 个用友插件（966 个 plugins 目录里另有 935 个 Eclipse 原生插件）
├─ yonyouplugins\features\       com.yonyou.ria.feature
└─ links\yylink.link             → dropins\yonyouplugins
```

插件按职能分五类：

**① 工程与启动（Eclipse 深度耦合）**
`nc.uap.mde`（模块工程 nature/ModuleBuilder/UAP 启动配置/UAPHOME link）、`com.yonyou.ria.g2*`（RIA 工程、类路径、安装盘、MDE→RIA 升级）、`com.yonyou.uat.plugin`（UAPUnit 测试类路径容器）

**② 元数据**
`NCMDP_6.5`（两个版本，776 个类：`.bmf/.bpf` 图编辑器、MDP Explorer、导出建表 SQL、ExportToCode、业务操作/活动视图）、`com.yonyou.uap.upm`（UPM 编辑器、Upm Resource View、Open Declaration）、`nc.uap.mde` 的 Business Component Explorer

**③ 交付**
`NCPlugin_1.0.5.4`（补丁包向导 + `ncpatch.sfx` 自解压壳、多语外部化、修改文件集）、`NCExport`（补丁安装盘）、`com.yonyou.uapstudio.patch`（UAPx6 补丁包）、`com.yonyou.ria.g2.disk`（导出安装盘）、`com.yonyou.ria.core.pdmexport`（PowerDesigner .pdm → 建库脚本）、`com.yonyou.ria.core.scriptexport`（导出预置脚本）

**④ 检查**
`com.yonyou.uapstudio.build.check`（10MB：依赖自动检查 builder、Ant 分层编译、依赖导出 Excel/Component.xml、错误标记收集面板、黑白名单）

**⑤ 杂项**
`com.yonyou.common.tablestruct`（更新公共主子表信息）、`com.yonyou.common.toolkit.uapmonitor`（启动 UAP Monitor）、`com.yonyou.uap.springxml2java`、`findbugs`、`org.eclipse.team.cvs.*`

顺带确认的两件事：
- 补丁包机制是 `NCPlugin` 的 `NCPatchJarWriter` + `ncpatch.sfx`（154 KB 的 DOS 自解压壳，zip 追加在后面）。NCForge 的补丁规范（zip + `CHANGES.md` + java/class 并排）已经成型，**不需要退回 sfx 形态**。
- 依赖检查的黑白名单文件几乎是空的（`blacklist.conf` 只有一行 `com\.sun\..*`），规则全在 Java 里，靠 jd-gui 才能读。

---

## 2. 逐项判定（31 → 4）

| 插件 | 干什么 | NCForge 现状 | 判定 |
|---|---|---|---|
| `com.yonyou.uap.upm` | UPM 装配编辑 + 接口/实现互相跳转 | `nchome_deploy.rs` 只做投送 | **搬 A** |
| `NCMDP_6.5` | `.bmf/.bpf` 图编辑器、导出建表 SQL、ExportToCode | 无 | **搬 B（只取数据，不取编辑器）** |
| `NCPlugin`（mlr 部分） | 中文硬编码 → 多语资源 | 无 | **搬 C** |
| `build.check` | 依赖检查 | 无 | **搬 D（最小版）** |
| `nc.uap.mde` | 模块 nature、ModuleBuilder、UAP 启动、link UAPHOME | `launch.rs` / `eclipse_cp.rs` / `nchome_deploy.rs` 已覆盖 | 不搬 |
| `com.yonyou.ria.g2*` | RIA 工程体系、安装盘、类型升级 | RIA 在 NC65 已是边缘技术 | 不搬 |
| `com.yonyou.uat.plugin` | UAPUnit 测试类路径、生成类/包测试 | 测试脚手架对二开意义小 | 不搬 |
| `NCExport` / `uapstudio.patch` | 补丁/安装盘向导 | 补丁已自研且更严（多层探测、完整方法签名） | 不搬 |
| `ria.core.pdmexport` | .pdm → 建库 SQL | 需要 XMI/XStream 解析，现场无 .pdm 需求 | 不搬（记为方案储备） |
| `ria.core.scriptexport` | 导出组件预置数据脚本 | 与现有 `db_export_insert` 能力重叠 | 不搬 |
| `tablestruct` / `uapmonitor` / `springxml2java` | 服务端同步 / 监控 / XML→Java | 依赖服务端接口或价值极低 | 不搬 |
| `findbugs` / `cvs` | 第三方 | 无关 | 不搬 |

---

## 3. A｜UPM 装配索引（P0）

### 3.1 为什么最值钱

NC 的调用链是「`NCLocator.lookup(IXxxService.class)` → 由 `<模块>/META-INF/*.upm` 决定用哪个实现类」。
二开现场最常见的三类事故全在这个文件上：

1. 实现类改了名/挪了包，`upm` 没改 → 编译全绿，启动才炸；
2. 新增服务忘了在 `upm` 里装配 → `NCLocator.lookup` 抛「找不到组件」；
3. 同一个接口在多个模块/多层被装配 → 打补丁后行为变了，但没人说得清谁覆盖了谁。

NCForge 现在对 `.upm` 只做投送（`nchome_deploy.rs`），**能把它送到 NCHOME，但读不懂里面写了什么**。这是目前最大的认知空白。

### 3.2 数据实测

工程侧 29 个：`<工程>/<模块>/META-INF/*.upm`
产品侧 1575 个：`<NCHOME>/modules/<模块>/META-INF/*.upm`

```xml
<?xml version='1.0' encoding='UTF-8'?>
<module name="aierreport">
  <public>
    <component remote="true" singleton="true" tx="CMT">
      <interface>nc.itf.aier.report.service.IAierICReportService</interface>
      <implementation>nc.impl.aier.report.service.AierICReportServiceImpl</implementation>
    </component>
  </public>
</module>
```

可用字段：`<module name>`、`public|private`、`component@remote/singleton/tx/supportAlias/priority`、`<interface>`、`<implementation>`。

### 3.3 三个必须兜住的坑

1. **`module name` 与目录/文件不一致**。实测 `ic/META-INF/icwl.upm` 里写的是 `name="puwl"`。
   ⇒ 索引的模块归属**以路径为准**，但把不一致作为诊断报出来（这类不一致正是「组件归错模块」的现成样本）。
2. **编码混放**。`aierreport.upm` 是 UTF-8，`icwl.upm` 是 `gbk`（注释直接是乱码）。沿用 `workspace::decode_lossy` 的思路：先按声明编码，失败再 GBK/UTF-8 双向兜底。
3. **同名 upm 在工程与产品两边都存在**。工程侧部署时会覆盖产品侧（`nchome_deploy.rs` 已经实现覆盖+备份），所以索引要带 `来源`（工程 / NCHOME）并让工程侧优先——否则用户点「找实现」会拿到被覆盖的旧类。

### 3.4 落地设计

- 新模块 `desktop/src-tauri/src/nc_upm.rs`（纯逻辑，不含 tauri 类型，可夹具测）：
  - `parse(&str) -> UpmDoc`：手写最小解析（同 `nc_manifest.rs` 的路子，不引 XML crate）
  - `index(roots: &[PathBuf]) -> UpmIndex`：合并工程侧 + NCHOME 侧，工程优先
  - `diagnose(&UpmIndex, class_exists: impl Fn(&str) -> bool) -> Vec<UpmIssue>`
- 新命令 `commands/upm_cmds.rs`：`nc_upm_index`（返回索引与诊断）、`nc_upm_lookup`（接口 → 实现列表）
- 前端：
  1. Java 编辑器光标停在接口/实现类上 → 命令面板「查找装配实现」（复用 `openPalette("type")` 通道，不新建 UI 框架）
  2. 诊断结果挂在现有「检查产物」式的列表里，不新开页
- 诊断规则（四条，都要有实据才报）：
  - `missing-impl`：`<implementation>` 指向的类在「工程源码 ∪ NCHOME 散类 ∪ jar 索引」里都不存在
  - `missing-interface`：接口不存在（实现还在，通常是重构残骸）
  - `duplicate-impl`：同一接口被多处装配且实现不同 —— 覆盖链风险
  - `module-mismatch`：`<module name>` 与所在目录不一致

> **实现时的纠偏**：原方案里的 `unassembled`（有 `*Impl` 但没被装配）已删掉。
> 工程里 135 个 `*Impl` 大部分本来就不需要 upm 装配（BO/DAO/内部类），
> 这条规则会产出上百条假警报。换成 `duplicate-impl`：它零猜测，有就是有。

### 3.5 验收

**落地实测（2026-11-04，实现完成后回填）**

| 项 | 实测 |
|---|---|
| 工程侧扫描 | 29 个 upm / 39 条装配（与 python 独立核对一致），冷读 0.5 秒 |
| 产品侧扫描 | 1575 个 upm / 10122 条装配，冷读 12 秒、热读 0.47 秒 |
| 实现类命中率 | 10122 条里未命中 **3 条（0.03%）**，全部在 `phm` 模块（`InspectapplyMaintainImpl` 等）；用 python 独立扫 `modules/phm` 的 jar 复核，确认**确实不存在**，不是索引漏收 |
| 类索引规模 | 3549 个 jar / 351008 个类 |
| NCHOME 散类 | 345 个 `classes` 目录里 **0 个 .class**（类全在 jar 里）⇒ 只查散类不能断言「类不存在」 |

0.03% 的未命中率说明「工程源码 ∪ 散类 ∪ jar」这个搜索范围没有洞，`missing-impl` 不会变成假警报。

**现成用例（必须能命中）**：`ar2025/eye` 的 `ic/META-INF/aiersign.upm` 装配的
`nc.itf.so.IAierPrintAndSignService` / `nc.impl.so.AierPrintAndSignServiceImpl` 在工程 `src`、NCHOME 散类、
**全库 6480 个 jar** 里都不存在。NCHOME 侧暂无该文件（`modules/ic/META-INF/` 只有产品自带 `SCM_IC_*.upm`），
但 `nchome_deploy.rs` 下次部署会把它送进组件注册表。已固化为 `#[ignore]` 真机快照测试 `upm快照_29文件39条装配与一条悬空`。

- 1575 + 29 个 upm 全量解析无 panic，成功率 ≥ 99%（失败的写日志不静默）
- `IAierICReportService` 能查到 `AierICReportServiceImpl`，带 `remote=true tx=CMT`
- `icwl.upm` 的 `puwl` 不一致被报出
- 删除某个 `<implementation>` 指向的类后重跑，`missing-impl` 命中

---

## 4. B｜元数据 bmf/bpf 索引（P1）

### 4.1 数据实测

`<NCHOME>/modules/<模块>/METADATA/`：**1207 个 `.bmf`（单据模型）+ 453 个 `.bpf`（业务处理流程）**，全是 XML，单文件几 KB～几十 KB。

`.bmf` 里能拿到（以 `aim/METADATA/equip.bmf` 为例）：
- 组件：`name="equip"` `displayName="设备卡片"` `ownModule="aim"` `resid="2451000401-0058"`
- 实体：`fullClassName="nc.vo.aim.equip.EquipHeadVO"`、`tableName="pam_equip"`、`displayName`、`isKey`、`dbtype`、`refModelName`、`length`
- 子表实体同样带 `tableName`（`pam_spare_part`、`pam_techvalues`）

`.bpf` 里能拿到（`equip.bpf`）：
- `<busioperation displayName="采购到货" fullClassName="nc.voaim.equip.ArrivalGoods" .../>` ×37
- `<operation>` / `<opinterface>` / `<opImpllist>`（操作 → 实现绑定）

### 4.2 价值边界（重要）

`md_dict.rs` 的注释已经写明「中文名不在 HOME 的 `.bmf`（那是设计态、且不含二开）」。本次实测确认：**二开工程自己的 `METADATA/` 是空的**，元数据只存在于标准产品侧。

所以 B 的定位不是「替代数据字典」，而是补两块 NCForge 现在没有的东西：

1. **不连库也能回答「表 ↔ VO 类」**。当前 `md_dict` 的实体列来自库里 `md_ormap`（1:N，要折叠），断网/无库时整列是空的。
2. **单据按钮 → 实现类**。这是线上排障最缺的一环：客户说「点采购到货报错」，现在只能全局搜中文，搜到一堆无关结果。

### 4.3 坑

- **脏数据**：`equip.bpf` 里 `fullClassName="nc.voaim.equip.ArrivalGoods"` 少了一个点（应为 `nc.vo.aim...`），元数据设计器的历史 bug。解析后必须校验包路径是否存在，不存在就标 `suspect` 并原样展示——**不要"修正"它**，那是撒谎。
- **编码**：`<?xml encoding='UTF-8'?>` 与 `gb2312` 都有，中文属性值必须按声明编码解，否则 `displayName` 全是乱码。
- **同表多实体**：`tableName` 会重复出现（主表 + 子表 + 扩展），索引结构必须是 `表 → [实体]`，不能假设一对一。这一条和 `md_dict` 的「实体是候选列表」保持同一口径。

### 4.4 落地设计

- 新模块 `desktop/src-tauri/src/nc_metadata.rs`：`parse_bmf` / `parse_bpf` / `build_index` / `table_to_vos` / `bill_op_to_class`
- 新命令 `commands/metadata_cmds.rs`：`nc_meta_bills`（组件清单）、`nc_meta_bill`（单个组件详情）、`nc_meta_table_vos`
- 前端入口（都是「挂到已有页面」，不新开 tab）：
  - 数据字典页：实体列增加「来源：库 / 元数据文件」，两路都有时并排显示（照抄 `md_dict` 的 `notes` 口径，多实体写进 notes）
  - 表上下文菜单：`查看元数据`（列出 bmf/bpf 定义、按钮清单，按钮可点进 Java 类）
- 缓存：按 `<home>` 指纹 + 文件 mtime，存 `config_dir`；解析失败的文件记 `warnings`，页面显示「N 个文件解析失败」，不静默吞。

### 4.5 验收

- 1207 + 453 个文件全量解析，失败数 = 0 或全部写进 warnings
- `pam_equip` → `nc.vo.aim.equip.EquipHeadVO`（`aim/equip.bmf`）
- `采购到货` → `nc.voaim.equip.ArrivalGoods` 且标记为可疑路径
- 二开工程（`ar2025/eye`）查不到元数据时提示「该模块没有元数据文件」，不是空列表

---

## 5. C｜多语资源（P1，先只读）

### 5.1 数据实测

工程侧：`<模块>/resources/lang/simpchn/<分类>/<文件>.properties`
产品侧：`<NCHOME>/langlib/*_langres.jar` 内的 `lang/simpchn/<分类>/<文件>.properties`（1457 个 jar）

内容就是 `key=中文`：
```
Odelete=删除
Oedit=修改
1015log=接口日志
```

### 5.2 最大的坑：编码不统一

- `uapbd/resources/lang/simpchn/funcode/uapbd_funcode.properties` → **UTF-8 明文**
- `uapbd/resources/lang/simpchn/1015log/1015log.properties` → **UTF-16BE + BOM（FE FF）**
- `langlib/aim_pub_sim_langres.jar` 里的 `pub_0/pub_aim.properties` → 同样是 UTF-16BE

这不是 Java 标准 properties 的编码（NC 有自己的资源加载器）。所以任何写回动作都必须**按原文件编码回写**，否则整个文件变乱码——这一条的破坏力比读错更大。

### 5.3 第一版只做查询

三个只读能力（零写入风险）：

1. **选中 Java 里的中文字面量 → 查已有 key**："这个'删除'是不是已经有 `Odelete` 了"，避免重复造 key。
2. **key → 使用位置**：`Odelete` 被哪些类引用。
3. **未翻译检查**：`simpchn` 里有、其他语种目录（若存在）没有的 key。

**外部化向导（自动抽字面量 + 改 Java 源）第一版不做**：项目已有铁律「生成/修复只落 Monaco model，不写用户文件」，而外部化必然要改源码。真要做，必须走「预览 diff → 用户逐条确认 → 写文件」，且要处理保留原编码、key 命名规则、注释与换行风格。这是独立一期的工作量，不要混进查询。

### 5.4 落地设计

- 新模块 `desktop/src-tauri/src/nc_lang.rs`：编码探测（BOM/UTF-16/GBK/UTF-8）、`properties` 解析（只切第一个 `=`）、`find_by_text` / `find_by_key`
- 新命令 `commands/lang_cmds.rs`：`nc_lang_find`（文本或 key）、`nc_lang_coverage`
- 前端：编辑器选中文字 → 命令面板「查多语资源」；结果走现有的列表式弹层（同 `openPalette`）

### 5.5 验收

- `1015log` 与 `uapbd_funcode` 两类编码都能正确读出中文
- 搜「删除」能同时命中 `Odelete`（langlib 或工程侧）
- 编码识别失败的文件计入 `warnings`，不返回空结果

---

## 6. D｜模块依赖检查（P2，可选）

Eclipse 的做法（`build.check`）：读 `component.xml` 的 `<dependencies>` + 源码 import，用 `TypeBindingValidator` 反查类型归属的模块，比对后报错；外加 Ant 分层编译（`public` → `client` → `private`）。

最小可搬版（**不做 Ant 分层编译**，NCForge 的 ecj 编译已经跑通且更快）：

- 输入：`<模块>/component.xml` 的 `<dependencies>` + 源码 `import` 列表
- 归属反查：复用 `nc_index.rs` 的「类名 → jar」索引，从 jar 路径拿到模块名
- 报两类：`undeclared`（用了别的模块但没声明）、`unused`（声明了但没用到）
- 坑：实测 `eye/ic/component.xml` 的 `<dependencies>` 是**空的**，但代码里 import 了 `nc.itf.aier.*`——要么依赖检查对二开模块普遍误报，要么这个工程本来就不合规。**做之前先拿 3～5 个模块跑一遍，确认误报率**，误报高的规则不做。

这条是四项里唯一「先验证再决定」的，别一上来就写死规则。

---

## 7. 明确不做

| 项 | 理由 |
|---|---|
| `.bmf/.bpf` 图形化设计器 | GEF 图形编辑器是重造一个 IDE；且二开不产生元数据，改图需求几乎为零 |
| `nc.uap.mde` 的 nature/builder/启动配置 | NCForge 已用 `.classpath` + `launch.rs` + `eclipse_cp.rs` 实现同类语义，且顺序规则更严 |
| `ncpatch.sfx` 自解压壳 | 现有 zip 补丁规范更易审计（`CHANGES.md`、方法签名完整） |
| RIA 全家（g2.*） | NC65 已是边缘技术栈 |
| `pdmexport` | 依赖 PowerDesigner XMI 解析，现场无需求；需要时再单独立项 |
| `ExportToCode`（元数据生成代码） | 生成物质量与维护成本都不划算，行业里也少用 |
| 多语**写回**（外部化向导） | 涉及改用户源码 + 编码回写，风险等级等同补丁写入，必须独立一期 |

---

## 8. 执行顺序与依赖

```
A（UPM 索引）       ← 无前置，复用 nchome_deploy 的 upm 枚举 + nc_index 的类索引
└─ B（元数据索引）  ← 与 A 共用「XML 最小解析 + 缓存 + 诊断」骨架，可并行开发但建议顺序交付
└─ C（多语查询）    ← 与 A/B 共用编码探测（建议先把 decode 抽成公共 util）
└─ D（依赖检查）    ← 依赖 A 的模块归属判定；先做误报率验证
```

建议三批交付：

- **第一批（A）**：`nc_upm.rs` + `upm_cmds.rs` + 两个前端入口 + 三条诊断。这一批做完，二开最痛的那类事故就有工具兜了。
- **第二批（B + C 只读）**：元数据索引接进数据字典与表右键；多语查询进命令面板。
- **第三批（D）**：先跑误报率，达标才写规则。

---

## 9. 三条工程约束（沿用现有约定）

1. **纯逻辑与 tauri 分离**：`nc_upm.rs` / `nc_metadata.rs` / `nc_lang.rs` 都不含 tauri 类型，原因见 `workspace.rs` 头注释（壳 crate 开 test feature 会让测试二进制启动即挂）。
2. **读不到就说读不到**：沿用 `nc_manifest.rs` 的口径——解析失败返回空清单 + 写 warnings，不 toast、不空树、不 panic。
3. **缓存要能失效**：工作区切换、部署到 NCHOME、upm 编辑保存后都要失效。照抄 `check_artifacts` 的过期签名思路（`名字:目录数[!disabled]` 那种，只比名字会漏判）。

---

## 10. 需要你定的三件事

1. **A 的入口放哪**：命令面板 + 编辑器右键（轻），还是单独一个「装配」侧栏页（重）？我倾向前者，先验证有人用再考虑独立页面。
2. **B 是否接进数据字典**：接进去要改 `md_dict.rs` 的实体列口径（库 + 文件两路来源），会动现有验收；也可以先做成独立的「元数据」弹层，不动字典。
3. **C 的外部化写回**：确认这一期只做查询、不写源码；如果现场确实高频需要「一键外部化」，那就单独立项，按改源码的风险等级重新设计。
