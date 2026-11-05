# NCForge 对标 UAP Studio：BMF 生成能力复刻与超越方案

> 范围：只讨论「从元数据（`.bmf`）生成单据代码与脚本」这条链路，以及生成前后的校验、预览、落盘与证据。
> 证据基线：本机 UAP Studio 6.5（`D:\NC65\yonyou_studio_nc65_wending`，Eclipse 4.3.2）+ `D:\tool\eclipsehy` dropins 里的 `NCMDP_6.5.0.201405291435.jar` / `com.yonyou.mdp.middleware.jar` + NC 1909 运行时配置 `D:\ncc\1909home\ierp\metadata`。
> 学习边界：只学流程契约、产物形状和可观察行为；不反编译业务实现，不复制用友 jar、模板、代码或资产。

## 0. 结论先行

1. **官方不是「一个生成按钮」，而是四条产物线共用一套元数据模型**：
   - Java 源码（MDP `ExportToCode`）
   - 建库 SQL / 元数据发布脚本（MDP `GenSqls` / `ExportMetaDataSqlFile`）
   - 单据资源与注册脚本（MDE RAD「单据向导」）
   - 格式/模型导出（XSD / WSDL / PDM / Feature / 接口属性映射）
2. **可复刻的产物约 24 类**，但价值密度差别很大。建议做成一个「生成中心」：同一份 BMF 一次计算全部派生件，按「数据库 / Java / 单据资源 / 注册」分组预览，勾选后落盘。
3. **分三批交付**：
   - **P0**：生成内核 + Java 全家桶 + 多方言 DDL + diff/清单/漂移检测。
   - **P1**：单据类型、编码规则、菜单/功能、单据/查询/打印模板、动作、多语等注册脚本，以及元数据发布 SQL。
   - **P2**：XSD/WSDL/PDM/特性/接口映射、批量与 CLI、官方 golden 保真门禁、模板覆盖。
4. **唯一建议缓做的是 NC65 RIA 前端 Java**（ClientUI / ClientCtrl / Handler / UIF XML）。目标运行时是 1909 时它已过时；只有明确要维护 NC65 RIA 单据时才做。
5. **超越点不在「产物更多」，而在官方没有的四件事**：逐文件 diff、生成清单与哈希、与真实库的漂移对照、官方输出 golden 回归。官方是「向导 → 直接执行」；我们做「预演 → 解释 → 受控落盘」。

---

## 1. 本机证据基线

### 1.1 两套入口

| 入口 | 版本/路径 | 作用 |
|---|---|---|
| NC65 UAP Studio | `D:\NC65\yonyou_studio_nc65_wending`，Eclipse 4.3.2 | MDP 资源管理器、BMF 编辑器、生成代码/SQL 向导；MDE 单据向导 |
| dropins 插件 | `D:\tool\eclipsehy\dropins\yonyouplugins\plugins\NCMDP_6.5.0.201405291435.jar`（2019-06-01） | MDP 编辑器与导出动作 |
| 发布/生成中间件 | 同目录 `com.yonyou.mdp.middleware.jar`（2014-02-27） | `SQLGenerator`、`PDMGenerator`、`MetaDataVOCodeGenerator` 等 |
| 1909 运行时配置 | `D:\ncc\1909home\ierp\metadata` | `baseType.xml`、`dbTypes.xml`、`Features.xml`、`Patterns.xml`、`AccessorTemplate.xml` |

> 说明：NC65 Studio 的插件是 6.5.x；1909 的配置格式相同但内容可能不同。所有契约必须按「配置来源」标注版本，不能把 6.5 的输出当成 1909 的保真基准。

### 1.2 生成相关的官方插件

| 插件 jar | 关键入口 | 说明 |
|---|---|---|
| `com.yonyou.studio.mdp.service.code_6.5.1.201412111333.jar` | `MDCodegeneralService`、`SelfDefCodeGenService`、`NCCodeGenerateService`、`OPCodeGenerateService` | 四种代码生成服务 |
| `com.yonyou.studio.mdp.service.code.jet_6.5.1.201412151334.jar` | `AggVOCodeTemplete`、`BeanItfTemplate`、`DefaultAggVOTemplate`、`DefaultOPItfTemplate`、`EnumVOTemplate`、`MetaCodeTemplete`、`MultiAggVOTemplate`、`SuperVOCodeTemplete`、`SuperVOTemplate` | 模板形状（只读模板名，不取模板内容） |
| `com.yonyou.studio.mdp.service.sqlgen_6.5.1.201501091333.jar` | `MDSqlGenService`、`GenerateSql`、`oracle.xml` / `mssql.xml` / `db2.xml` | 建库/元数据 SQL |
| `com.yonyou.studio.mdp.service.pdmgen_6.5.1.201412111333.jar` | `MDPDMGenerateService`、`PDMGenerator` | 导出 PDM |
| `com.yonyou.studio.mdp.service.publish_6.5.1.201408051333.jar` | `DataAssociationGenerator`、`BizModelAssociationGenarator`、`ExportMetaDataSqlServiceImpl` | 发布与关联注册脚本 |
| `com.yonyou.studio.mdp.database_6.5.1.201408051333.jar` | `TranslateToDB2/Gbase/Informix/Oracle/Oscar/PostgreSQL/SqlServer/Sybase` | 8 种数据库方言翻译 |
| `com.yonyou.studio.mdp_6.5.1.201501071336.jar` | `ExportToCodeWizard`、`GenSqlsWizard`、`ExportMetaDataSqlFileWizard`、`GenXSDFileWizard`、`GenWSDLWizard`、`ExportPDMFileWizard`、`ExportFeatureWizard`、`ExportMappingWizard`、`NewMDFileWizard` | 全部导出/新建向导 |
| `com.yonyou.studio.ria.rad.wizard.core_6.5.0.420140617.jar` | `SingleBillAction`、`SingleDocAction`、`SingleTreeAction`、`MultiBillAction`、`BatchGenCodeAction`、`FileGenerator`、`UIF2ModelFileGenerator` | MDE 单据向导与批量生成 |
| `com.yonyou.studio.ria.billtype.editor.ui` / `coderule.editor.ui` | `BilltypePublishAction`、`BcrPublishAction`、`*SynAction` | 单据类型/编码规则发布与同步 |
| `bmfplugin_16.6.21.eye.jar` | `NewBillInfoAction` 等 | 第三方「UAP助手」，只生成 BMF 骨架，不属于官方 MDP |

### 1.3 运行时契约配置

| 文件 | 本机实测 | 用途 |
|---|---|---|
| `baseType.xml` | 21 个基础类型（String/UFID/Integer/UFDouble/UFBoolean/UFDate/UFDateTime/...） | 逻辑类型 → DB 类型/长度/精度 |
| `dbTypes.xml` | char/varchar/image/decimal/text | 合法 DB 类型 |
| `Features.xml` | 6 个特性：TreeMode、creditMode、orgAuditInfo、Innercode、version、orgDef | 「套用特性」批量补字段 |
| `Patterns.xml` | 订单模式示例（主子表 + 枚举 + 值对象） | 模式复用 |
| `AccessorTemplate.xml` | POJO / NCVO / AggVO，AggVO 带 `wrapclsname` | 访问器 → Java 形状 |
| `AttrAccessors.txt` | `PojoAccessor` / `NCBeanAccessor` / `BodyOfAggVOAccessor` | 访问器实现映射 |

---

## 2. 官方生成功能全清单（按产物）

### 2.1 Java 源码（MDP「生成 Java 源代码」）

入口：`ExportToCodeWizard` + 四种 `MDCodeService`；模板名见 1.2。

| 产物 | 生成条件/形状 | 证据 |
|---|---|---|
| `XxxVO`（NC 传统样式） | 组件代码风格 = NC传统样式；普通实体 `extends SuperVO`，主实体/组合关系按 AggVO 组织 | `NCCodeGenerateService`、`NCCodeValidate_2` |
| `XxxVO`（标准样式） | 代码风格 = 标准样式；SuperVO 形状 | 社区文档与 `SuperVOTemplate` |
| `XxxVO`（自定义样式） | 按 PubApp 规则；可关闭 `UFBoolean -> Boolean` 转换 | `SelfDefCodeGenService`、`GenSqlsSetPage_3` |
| 聚合 VO（AggVO） | 主实体访问器 = AggVO；包装类名 `wrapclsname`；主子关系；NC传统样式下组合关系实体不能设为非 AggVO | `DefaultAggVOCodeGenerator`、`AccessorTemplate.xml`、`NCCodeValidate_2` |
| 多子表聚合 VO | 一个主实体聚合多个子实体 | `MultiAggVOTemplate` |
| 子表 VO | 子实体访问器 NCVO/POJO | `DefaultAggVOTemplate` |
| SuperVO / 父类 | 继承实体的公共字段/父类 | `SuperVOCodeGenerator` |
| 枚举 VO | `Enumerate` → `XxxEnumVO`，含枚举项常量 | `EnumVOCodeGenerator`、`EnumVOJETObject` |
| 业务接口 BeanItf | 实体实现的业务接口 | `BeanItfCodeGenerator`、`BeanItfTemplate` |
| 操作接口 OPItf | 业务操作定义 | `OPInterfaceCodeGenerator`、`DefaultOPItfTemplate` |
| 查询 VO（SelVO） | 选择/查询模型 | `SelVOCodeGenerator` |
| 测试类 | 官方生成目录里会出现 test 下的单元测试桩；社区实测主子表单据共生成 4 个 Java 类 | 社区文章（见 §13） |
| 本地化 | 生成资源/多语文件 | `DestDirectoryPage_2=本地化` |
| 其他选项 | 「只生成扩展表」；「导出 SQL 语句（带外键信息）」 | `DestDirectoryPage_1/3/5` |

**官方校验（生成前）**：

- 实体访问器为空 → 报错。
- NC 传统样式下，含组合关系的实体不能设为非 AggVO。
- 主属性为空 / 属性所属实体无效 → 生成策略报错。

### 2.2 建库 SQL 与元数据发布脚本（MDP）

| 产物 | 入口 | 选项/范围 | 证据 |
|---|---|---|---|
| 建表 SQL | `GenSqlsWizard` / `GenSqlModel` | 单组件或多组件统一生成；目标根目录；可关闭对话框 | `GenSqlModel_*`、`GenSqlsSetPage_*` |
| 外键/约束 | `GenSqlsWizard` | 「导出 SQL 语句（带有外键信息）」 | `DestDirectoryPage_1/3/4` |
| 扩展表模式 | `GenSqlsWizard` | 「只生成扩展表」 | `DestDirectoryPage_5` |
| 元数据发布脚本 | `ExportMetaDataSqlFileWizard` | 从画布对象或文件导出；`proinfo` 必填 | `ExportMetaDataSqlFileWizard_*` |
| 元数据 SQL 方言 | `sqlgen/oracle.xml`、`mssql.xml`、`db2.xml` | 3 套脚本模板 | jar 内资源 |
| DDL 方言 | `com.yonyou.studio.mdp.database` | 8 种：DB2 / GBase / Informix / Oracle / Oscar / PostgreSQL / SQLServer / Sybase | `TranslateTo*` |
| 发布关联脚本 | `publish` jar | 数据关联、业务模型关联 | `DataAssociationGenerator`、`BizModelAssociationGenarator` |
| 模块统一生成 | `GenSqlModel_10` | 只有同一模块下的元数据才能统一生成 | 消息文本 |

### 2.3 单据资源与注册脚本（MDE RAD「单据向导」）

入口：`SingleBillAction`（单表单据）、`SingleDocAction`（单表档案）、`SingleTreeAction`（树卡）、`MultiBillAction`（主子表）；`BatchGenCodeAction` 批量。

**输入**：BMF 文件、业务组件、实体组件名称、单据类型（4 位大写字母+数字）、单据日期字段、功能编码/名称、菜单编码/名称、上级节点、组织类型、项目 Excel（模块/菜单/功能规划）、多语。

**产物（向导完成页逐项显示）**：

| 产物 | 证据（消息键） |
|---|---|
| 代码资源文件（前台代码/UI 工厂脚手架） | `CommonResGeneResultPages_21/30` |
| 单据类型脚本 | `CommonResGeneResultPages_25` |
| 单据号编码规则脚本 | `CommonResGeneResultPages_27` |
| 单据模板脚本 | `CommonResGeneResultPages_16` |
| 查询模板脚本 | `CommonResGeneResultPages_20` |
| 打印模板脚本 | `CommonResGeneResultPages_23` |
| 菜单注册脚本 | `CommonResGeneResultPages_14` |
| 功能注册脚本 | `AddResToListUtilFirst_139` |
| 动作脚本（审批/提交/弃审/收回/删除等） | `AddResToListUtilFirst_175/178/181/184/187/190` |
| 多语资源（功能/菜单/模板） | `CommonLanguagePage_*`、`MultiLanguagePage_*` |
| 业务规则脚本（十余条模板） | `RuleListUtils_0..14` |
| 自动生成 `.bpf` | `SingleBaseDocItfNamePage_23` |
| 资源发布 | `CommonScriptPage_5` |
| 项目规划 Excel 导入 | `CommonBeanPage_Excel_Not_Found` |

**生成前校验**：

- 单据类型必须 4 位大写字母/数字。
- `bd_billtype.pk_billtypecode`、`billtypename` 不能重复。
- `pub_bcr_rulebase.rulecode` / `nbcrcode` 不能重复。
- `sm_permission_res.resourcecode` 不能重复。
- 单据类型已存在时，只能继续生成前台代码。
- 元数据中单据状态类型必须是枚举。

### 2.4 格式/模型导出（MDP）

| 产物 | 入口 | 说明 |
|---|---|---|
| XSD | `GenXSDFileWizard` | 选择行/文件，生成 XSD |
| WSDL | `GenWSDLWizard` | 选择目标目录 |
| PDM | `ExportPDMFileWizard` | 导出 PowerDesigner 模型 |
| 特性（Feature） | `ExportFeatureWizard` | 从选中属性导出特性；`Features.xml` 6 个内置特性 |
| 业务接口属性映射 | `ExportMappingWizard` | 接口属性 ↔ 元数据属性映射 |
| MBE 导出 | `ExportMBEWizard` | 扩展模型 |
| 新建元数据 | `NewMDFileWizard` | bmf / mbe / mbp / bpf |

### 2.5 输入侧（生成的前置数据）

| 输入 | 入口 | 说明 |
|---|---|---|
| PDM 导入 | `ImportAttrWizard`、`SelPDMFilePathWizardPage` | 从 PDM 导属性 |
| 数据库表导入 | `SelDBTableWizardPage`、`SelTableColumnWizardPage` | 从现有表反向生成属性 |
| Excel 导入 | `ImportExcelFileWizard` | 官方格式字段导入 |
| 接口导入 | `ImportItfWizard` | 业务接口 |
| 多语维护 | `MultiLangWizard` | 多语言资源 |
| BMF 转换 | `TransBMFWizard` | 模型转换/迁移 |

### 2.6 发布与同步（生成链的终点，不直接复刻写库）

- `PublishServiceImpl.publishMetaData`：写 `md_*`、加载依赖、`JGraph.validate()`。
- `BilltypePublishAction` / `BcrPublishAction`：单据类型、编码规则发布到 DB；支持强制发布/同步。
- `BilltypeSycnDB2FileAction` / `BcrSynAction`：DB 与文件双向同步。

> 结论：**生成可以离线复刻；发布写库不在本方案范围内**。我们只产出脚本、预览和校验，执行留给用户或现有 DB 工作台。

---

## 3. 目标流水线

```text
BMF + 生成配置（风格/包根/方言/选项）
      │
      ├─ 校验器（规则 + 官方配置契约）
      │
      ├─ 产物图（Artifact Graph）
      │    ├─ Java：VO / AggVO / EnumVO / SuperVO / Itf / OP / Sel / Test
      │    ├─ DB：DDL（8 方言）/ 外键索引 / 元数据发布 SQL
      │    ├─ 单据资源：类型 / 编码规则 / 菜单功能 / 三模板 / 动作 / 多语
      │    └─ 格式：XSD / WSDL / PDM / Feature / Mapping
      │
      ├─ 预览与 diff（逐文件、逐字段来源）
      │
      └─ 受控落盘（原子写 + 清单 + 哈希 + 漂移检测）
```

原则：

- **生成物是派生物，不是真相**：BMF 永远是源；生成文件带归属标记，手改文件不静默覆盖。
- **预览默认，执行显式**：默认只生成内存预览与 diff；落盘是第二步；执行 SQL 是第三步。
- **一处推导**：包名、类名、表名、字段名、单据类型、菜单编码的命名规则集中在 `GenProfile`，不散落在各渲染器。
- **配置来自用户环境**：`baseType.xml` / `dbTypes.xml` / `Features.xml` / `Patterns.xml` / `AccessorTemplate.xml` 运行时只读加载，并在 UI 显示来源与版本；不打包进安装包。
- **可重复**：同一 BMF + 同一配置 + 同一工具版本 → 字节一致（除时间戳）。

---

## 4. 与 NCForge 现状的差距

现状（`desktop/src-tauri/src`）：

- `bmf_model.rs`：完整 BMF 解析（组件/实体/属性/枚举/关系）。
- `bmf_rules.rs`：结构/语义校验。
- `bmf_gen.rs`：Oracle DDL（预演）、单实体 VO（NC 传统形状）、注册清单。
- `bmf_export.rs`：计划 + 原子写 + 编码/换行。
- `bmf_scaffold.rs`：5 种 BMF 骨架（新文件）。
- `bmf_excel.rs`：自有模板导入/导出。
- `db_*`：数据库连接、schema、查询、导出。

| 能力 | 官方 | NCForge 现状 | 差距 |
|---|---|---|---|
| NC 传统 VO | 有 | 有（单实体） | 缺 ts 以外的官方细节、测试类、继承 |
| 标准/自定义样式 | 有 | 无 | 三档代码风格 |
| AggVO / 多子表 | 有 | 无 | 主表聚合、包装类、子表访问器 |
| EnumVO | 有 | 无 | 枚举常量/构造 |
| SuperVO / 继承 | 有 | 无 | 父类字段合并 |
| BeanItf / OPItf | 有 | 无 | 接口与操作 |
| SelVO | 有 | 无 | 查询模型 |
| DDL 方言 | 8 种 | Oracle 1 种 | 7 种 + 方言抽象 |
| 外键/索引/约束 | 有 | 部分/无 | 从关系生成 |
| 元数据发布 SQL | 有 | 无 | `md_*` 脚本（只导出） |
| 单据类型/编码规则脚本 | 有 | 无 | 注册脚本 |
| 菜单/功能/模板/动作/多语 | 有 | 无 | 单据向导产物 |
| XSD/WSDL/PDM/Feature/Mapping | 有 | 无 | 格式导出 |
| 预览/diff/清单/漂移 | 无（直接执行） | 部分（注册清单） | **超越点** |
| 与真实库对照 | 弱 | 有 DB 工作台 | **超越点** |

> 既有决策说明：`docs/NCForge-借鉴Eclipse行业插件-能力迁移方案-20261104.md` 曾把 `ExportToCode` 列为不做，理由是「生成物质量与维护成本」。本方案按用户明确要求重新纳入，但用「只生成新文件/带标记文件 + diff 确认 + 清单」控制维护成本，不回到「整仓代码重生成」。

---

## 5. 目标架构

### 5.1 生成配置 `GenProfile`

```text
GenProfile {
  codeStyle: NC传统 | 标准 | 自定义
  targetModule, basePackage, publicSrcRoot, clientSrcRoot
  dbDialect: oracle | postgresql | sqlserver | db2 | gbase | informix | oscar | sybase
  options: {
    generateAggVO, generateEnumVO, generateInterfaces, generateSuperVO,
    generateTest, generateOnlyExtensionTables, withForeignKeys,
    overwritePolicy: never | diff | force,
  }
  bill: { billTypeCode, billTypeName, billDateField, functionCode, menuCode, ... }
}
```

### 5.2 产物图 `ArtifactGraph`

每个产物节点：

```text
Artifact {
  id, family: java|db|bill|format,
  pathHint, encoding, eol,
  sourceRefs: [entityId/attrId/enumId/relationId],
  dependsOn: [artifactId],
  ownerMarker, render(...)
}
```

产物图解决官方没有的三个问题：

- **顺序**：SuperVO 先于子 VO；枚举先于引用它的 VO；DDL 先于注册脚本。
- **影响面**：改一个字段，列出受影响的 Java 文件、SQL 列、模板/脚本项。
- **选择性生成**：按 family/实体/文件勾选，而不是整包重刷。

### 5.3 渲染器

- Rust 纯函数：输入 `BmfDoc + GenProfile + 官方配置`，输出 `GeneratedFile { text, encoding, eol }`。
- 每个 family 一个模块：`gen_java.rs`、`gen_ddl.rs`、`gen_bill_scripts.rs`、`gen_formats.rs`。
- 类型映射统一走 `TypeMap`：`dataType/typeName` → `baseType.xml` → DB 类型/长度/精度 → Java 类型；`dbtype` 为空时回退 `fieldType`（已在结构基线中体现）。
- 模板不内嵌官方资产：结构由字段清单与规则拼装；若将来支持用户模板，只读取用户目录，不随包分发。

### 5.4 预览 / diff / 落盘

- 内存预览：文件列表 + 每文件文本 + 摘要（新增/修改/不变/冲突）。
- diff：unified diff；点击字段可回溯到 BMF 属性（来源标注）。
- 落盘：
  - 新文件：原子写。
  - 已存在且由本工具生成（有归属标记 + 清单哈希匹配）：可覆盖，写前备份。
  - 已存在但无标记/哈希不匹配：只给 diff，需要显式「覆盖 / 另存 / 取消」。
  - 永不静默改用户手写代码。
- 编码/换行：目标文件存在则探测 BOM/EOL；否则用 `GenProfile` 默认（GBK + CRLF）。

### 5.5 清单与漂移

`{config_dir}/generation/<component>.json`：

```text
{
  bmfPath, bmfSha256, bmfVersion, toolVersion,
  profileHash, configSources: {baseType, features, accessors, dbTypes},
  artifacts: [{path, family, sha256, generatedAt}]
}
```

漂移检测（超越点）：

- BMF 变了但产物没重生成 → `stale`。
- 产物被手改 → `modified-since-generation`。
- 产物存在但 BMF 已删实体 → `orphan`。
- 数据库列与 DDL 预览不一致（复用 DB 工作台）→ `db-drift`。
- 生成清单中的配置版本与当前 NCHOME 不同 → `config-drift`。

### 5.6 UI 与 CLI

- UI：元数据页新增「生成中心」页签（不塞进现有发布探针）。左侧产物树（按 family），中间预览/diff，右侧配置与来源。
- CLI（P2）：`ncforge gen plan|apply|check --bmf ... --profile ...`，给 CI 做漂移检查；`check` 只读，失败返回非 0。
- 生成属于「写操作」，遵循现有桌面端「独立页签 + 显式确认」约定。

---

## 6. 分期

### P0：生成内核 + Java 全家桶 + 多方言 DDL（建议先做）

交付：

1. `GenProfile` + 产物图 + 统一命名/类型映射。
2. Java：
   - 三档代码风格（NC传统/标准/自定义）。
   - 单实体 VO、AggVO、子表 VO、多子表 AggVO、SuperVO、EnumVO、BeanItf、OPItf、SelVO、测试桩。
   - 本地化开关；`UFBoolean -> Boolean` 转换开关。
3. DDL：
   - 8 方言抽象；主键、非空、默认值、精度/标度、注释（有则生成）。
   - 从 `AggregationRelation`/`Reference` 生成外键/索引（有声明才生成）。
   - 「只生成扩展表」选项。
4. 预览/diff/清单/漂移；原子写；编码/EOL 探测。
5. 性能底座：一次解析 + 产物图 + 增量快路径 + 阶段耗时 `timings` + 有界并发（详见 §12）。
6. 门禁：3 种风格 × 5 种形状 = 15 个样本，与官方输出逐行 diff；差异必须有解释。

验收：

- 15 个样本全部能生成；无悬空引用；类名/包名/字段顺序与官方一致（归一化后）。
- 同一 BMF 重复生成字节一致（时间戳除外）。
- 已有文件不 diff 不覆盖；手改文件被标记为 `modified-since-generation`。
- DDL 在 Oracle/PostgreSQL 上用测试库空 schema 验证（只建表、不写业务数据）；其余 6 种仅做 golden/语法检查，并明确标注「未在真实库验证」。
- 性能预算全部达标：典型组件端到端 P95 ≤4 s、硬上限 10 s；重复生成 ≤1 s（§12.2）。

### P1：单据注册脚本 + 元数据发布 SQL

交付：

1. 单据类型脚本（`bd_billtype`）、编码规则脚本（`pub_bcr_rulebase`）。
2. 功能/菜单注册脚本（`sm_permission_res` 等），含 4 位单据类型与重复检查。
3. 单据模板 / 查询模板 / 打印模板脚本。
4. 动作脚本（审批、提交、弃审、收回、删除等）。
5. 多语资源（功能/菜单/模板）。
6. 元数据发布 SQL（`md_*`），只导出不执行；3 套方言模板（Oracle/MSSQL/DB2）。
7. 业务规则脚本模板（十余条）。
8. 项目规划 Excel 输入（模块/菜单/功能）——与自有模板分开标注。

验收：

- 每个脚本都有「目标表、影响行、冲突项」预览。
- 重复单据类型/编码/资源编码在生成前被拦截。
- 与官方脚本逐项对比：表名、列名、关键值一致；格式差异有解释。
- 不在任何真实库执行；只输出 `.sql` 和校验报告。

### P2：格式导出、批量与保真门禁

交付：

1. XSD / WSDL / PDM / Feature / 接口属性映射导出。
2. 批量：多组件/多模块统一生成（复用 MDP 的模块约束语义）。
3. CLI 与 CI：`gen check` 漂移门禁。
4. 官方 golden 回归：固定语料 + 归一化比较；本地跑官方 Studio 生成基准，仓库只存语义快照/哈希（不存官方模板资产）。
5. 用户模板覆盖（可选）：只读用户模板目录，带版本/哈希与保真标记；自有模板与官方保真模板分栏显示。

验收：

- 6 个内置特性可套用/导出；映射导出可被官方工具读回。
- `gen check` 能对「BMF 改了但产物没更新」返回非 0。
- golden 语料覆盖 3 种风格、单表/主子表/树卡/多子表/枚举/接口。

### P3（条件触发）：NC65 RIA 前端 Java

- `ClientUI` / `ClientCtrl` / `ClientEHandler` / `AceAddHandler` / UIF XML → Java。
- 触发条件：用户明确仍在维护 NC65 RIA 单据，且 1909 前端不是目标。
- 不触发时不做：RIA 在 1909 已不是主栈，复刻成本高、验证面大。

---

## 7. 做得更好的地方

| # | 能力 | 官方 | 我们的做法 |
|---|---|---|---|
| 1 | 预览/diff | 向导直接执行 | 默认只预览；逐文件 diff；字段可回溯 BMF |
| 2 | 生成清单 | 无 | BMF 哈希 + 配置哈希 + 产物哈希 |
| 3 | 漂移检测 | 无 | stale / modified / orphan / db-drift / config-drift |
| 4 | 与真实库对照 | 弱 | 复用 DB 工作台，列级差集；生成前提示 |
| 5 | 影响面分析 | 无 | 改字段前列出受影响产物与注册项 |
| 6 | 校验解释 | 偏底层 | 错误 → 原因 → 修复建议 → 跳转字段 |
| 7 | 配置可追溯 | 隐式 | 显示 baseType/Features/Accessor 来源与版本 |
| 8 | 选择性生成 | 整包 | 按 family/实体/文件勾选；依赖自动补齐 |
| 9 | CI/无头 | 无 | `gen check` / `gen apply` |
| 10 | 保真门禁 | 无 | 官方 golden 归一化 diff + 反例注入 |
| 11 | 安全 | 直接执行 | 预览 → 落盘 → 执行三段式；默认不执行 |
| 12 | 幂等 | 覆盖 | 相同输入字节一致；手改不静默覆盖 |

---

## 8. 验收与证据

### 8.1 语料

- 仓内合成：`sz02`（主子表+枚举+关系）、`demo_simple`（单表）、`broken`（反例）。
- 真实：用户环境 1207 个 `.bmf` 中抽取 20 个，覆盖三种代码风格、单表/主子表/树卡/多子表/枚举/接口。
- 官方基准：在独立 NC65 测试环境用同一 BMF、同一配置生成；只保存语义快照/哈希，不把官方模板或产品源码入库。

### 8.2 比较方法

1. 归一化：包名/类名按参数替换；空白、注释时间、文件顺序忽略；字段/方法/常量顺序按 BMF 语义比较。
2. 差异分类：`语义差异`（失败）/`格式差异`（记录并解释）/`官方缺陷`（记录，不盲目跟随）。
3. 反例注入：改字段长度、删枚举项、改访问器、重复单据类型、空访问器、NC 风格 + 组合关系非 AggVO；门禁必须变红。
4. SQL：Oracle/PostgreSQL 用空 schema 实际建表验证；其余方言只做 golden 与语法检查，明确「未在真实库验证」。
5. 脚本：只做静态比对与冲突检查；不执行写库。

### 8.3 安全与许可

- 不打包、不复制、不分发用友 jar / 类文件 / 模板 / 产品源码。
- 运行时只读用户 NCHOME 配置；生成物是用户工程的派生物。
- golden 语料只用用户自有环境的输出，且不入库分发。
- 所有写操作走原子写 + 备份 + diff；SQL 默认只导出。

---

## 9. 不做项与触发条件

| 不做 | 原因 | 什么时候再做 |
|---|---|---|
| 直写 `md_*` / 自研发布协议 | 版本、行业、缓存、权限都在 NC 运行时；写错直接污染库 | 永不；只导出脚本，执行留给官方/用户 |
| 自动执行生成的 DDL | 建表/改表不可逆，官方也是显式执行 | 现有 DB 工作台二次确认后可执行；生成中心不默认执行 |
| 分发/内置用友 jar 与模板 | 许可与分发风险 | 不做 |
| 反编译 `PublishServiceImpl` / `MetaDataVOCodeGenerator` | 只学契约，不抄实现 | 不做 |
| GEF 式自由画布 | 成本高、收益低；表格式更适合字段工作 | 只读关系图不够用时 |
| NC65 RIA 前端 Java | 1909 非主栈；产物多、验证面大 | 用户明确维护 NC65 RIA 单据 |
| 自动改用户手写 Java | 覆盖风险不可接受 | 只对带归属标记的生成文件操作；手写文件只给 diff |
| 自动改 `.upm` / 六处注册 | 写错会导致启动失败 | 先给清单与补丁建议，P2 后再议 |
| PDM 导入（反向） | 低频；本方案先做导出 | 有真实 PDM 样本与诉求 |

---

## 10. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| BMF 语义未完全文档化 | 未知节点/字段导致生成偏差 | 字节区间保留 + 官方输出 diff + 真实样本回归 |
| 6.5 与 1909 配置/产物不同 | 把 6.5 当 1909 基准 | 配置来源标注版本；两套 golden；差异必须解释 |
| 代码风格组合爆炸 | 15+ 种形状，测试成本高 | 先做 NC传统 + 标准；自定义样式按真实样本补 |
| 模板/格式细节缺失 | 生成物不能编译/不能读回 | 生成后跑编译/官方打开验证；失败回滚 |
| 脚本格式依赖 DB 方言 | 只在 Oracle 验证会漏 | 8 方言 golden；明确未验证项 |
| 用户手改生成文件 | 覆盖丢代码 | 归属标记 + 哈希 + diff + 备份 |
| 生成物规模大 | 内存/UI 卡顿 | 流式预览、按 family 懒加载、单文件 diff |
| 许可边界 | 不能分发官方资产 | 只读用户环境；不入库 |

---

## 11. 需要拍板

1. **目标代码风格**：先做 NC传统 + 标准，还是三档一起？（建议先两档，自定义按真实样本补）
2. **单据脚本范围**：P1 是否包含多语与动作脚本，还是只做类型/编码规则/三模板/菜单？
3. **生成落盘位置**：只写当前工程 `src/public`，还是允许指定输出目录（供预览/交付）？
4. **执行边界**：生成中心永不执行 SQL，还是允许跳转 DB 工作台执行（保留二次确认）？
5. **golden 来源**：是否允许在测试机跑官方 Studio 生成基准（只存语义快照，不入库）？
6. **RIA 前端**：目标是否包含 NC65 RIA 单据？默认不包含。

---

## 12. 性能预算与卡顿防治

> 用户要求：从 BMF 生成单据代码/脚本，**典型场景 10 秒内完成，越快越好**；不能出现官方那种长时间无响应。
> 这里的 10 秒是**硬上限**，不是目标值。目标值是典型组件 1～3 秒，重复生成 <1 秒。

### 12.1 官方为什么卡

以下按「本机插件链可证实」与「从入口结构可推断」分开写，不把推断当结论：

| 根因 | 性质 | 证据/机制 |
|---|---|---|
| Eclipse/OSGi 冷启动、插件加载 | 已证实 | 生成入口在 Eclipse RCP 内；`UAP-STUDIO.bat` 启动 Equinox，`-Xmx386m` |
| GEF/JGraph 模型加载 | 已证实 | 发布/校验链 `JGraphSerializeTool.loadFromFile` → `JGraph.validate()`；类加载拉 `org.eclipse.draw2d` |
| NC 运行时反射 + 类加载 | 已证实 | `ClassTool.getClassLoader()`、`PublishServiceHelper.generateSQLByComponent` 反射调用 |
| 数据库依赖查询 | 已证实 | `PublishServiceImpl` 用 `NCLocator`/`BaseDAO`/`JdbcSession`；发布前查依赖 |
| 每个实体重复解析/重复校验 | 推断 | 各向导按实体/文件循环；缺少一次解析的产物图 |
| 模态向导阻塞 UI 线程 | 已证实（结构） | 生成在 `Job`/Wizard 中执行，完成前界面不可交互 |
| 生成后刷新/编译工程 | 推断 | 官方会生成 test 桩并提示刷新 Java 工程 |

**我们的结论**：卡顿不是「Java 生成本身慢」，而是**重宿主 + 重模型 + 重数据库 + 阻塞式 UI** 的叠加。复刻时这四层都要拆掉，而不是把 Java 代码翻译成 Rust 就完事。

### 12.2 性能目标（硬指标）

以「单组件、主子表、20 实体/500 属性/80 产物」为典型上限：

| 场景 | P50 | P95 | 硬上限 |
|---|---|---|---|
| 打开生成中心（读 BMF + 校验 + 产物清单） | ≤300 ms | ≤800 ms | 2 s |
| 生成全部预览文本（Java + DDL + 脚本） | ≤1.2 s | ≤3 s | 5 s |
| 勾选落盘（≤100 个文件，仅写变更） | ≤1 s | ≤2 s | 3 s |
| 端到端「预览 → 落盘」 | ≤2 s | ≤4 s | **10 s** |
| 重复生成（BMF/配置未变） | ≤200 ms | ≤500 ms | 1 s |
| 漂移检查（`gen check`，无 DB） | ≤500 ms | ≤1.5 s | 3 s |
| UI 主线程单次阻塞 | — | — | 16 ms |

超出典型上限（例如 100 实体/5000 属性）：允许分批/按 family 生成，但必须**持续出进度、可取消**；任何阶段不得出现无反馈等待超过 1 秒。

### 12.3 架构级性能约束

1. **一次解析**：BMF 只解析一次，构建 `id → entity/attr/enum/relation` 索引；所有渲染器共享只读视图，禁止每个产物重新扫 XML。
2. **一条产物图**：产物依赖、路径、来源一次算完；渲染是纯函数，不查库、不读文件系统、不加载类。
3. **零 NC 运行时**：不加载 NC jar、不反射、不连数据库、不启动 JVM。类型映射只读 `baseType.xml`/`dbTypes.xml`/`AccessorTemplate.xml` 的本地副本（带 mtime 缓存）。
4. **增量优先**：清单记录 BMF 哈希 + 配置哈希 + 工具版本 + 产物哈希；未变化直接返回 `unchanged`，不重新渲染、不重写文件。
5. **懒渲染**：UI 先拿到产物清单与摘要；只有展开/选中的文件才渲染全文和 diff。大文件按块返回，不一次性塞进 WebView。
6. **有界并发**：独立产物可并行渲染，但线程数固定为 2～3（遵守本机重负载约束），不按 CPU 核数无限开；文件写入串行或小并发，避免 Windows 杀毒/索引器放大 IO。
7. **流式/预分配**：字符串用 `String::with_capacity` + `write!`，禁止在循环里反复 `format!` 拼接大文本；避免对全文做正则。
8. **前端不卡**：生成在 Tauri 异步命令中执行；UI 用虚拟列表 + 按需 diff；进度事件 ≤10 次/秒，避免事件风暴；禁止把 100 个文件全文放进一个 React state。
9. **可取消/可降级**：每个阶段带 deadline；用户取消立即停止；超时返回已完成部分 + 明确状态，不假装成功。
10. **可观测**：返回体带 `timings { parse, validate, graph, render, diff, write }`；日志只记阶段耗时，不打印全文。

### 12.4 度量与门禁

- **Rust 基准**：新增 `tests/bmf_gen_perf.rs`（release 模式），语料 = 1 个典型合成 BMF + 1 个大规模合成 BMF + 20 个真实 BMF（只读，缺失则跳过）。每项跑 5 次取 P50/P95。
- **预算文件**：`benchmarks/bmf-gen-budget.json` 存各阶段上限；超限失败，回归 >20% 也失败。
- **反例**：构造 100 实体 × 50 属性的病态 BMF，验证「不 O(n²)、不超时、可取消」；构造超长字段名/大量枚举项，验证字符串拼接不爆内存。
- **前端**：用 100 产物 fixture 测生成中心首屏与展开 diff；主线程长任务 >50ms 记失败。
- **对照**：在测试机用官方 Studio 对同一 BMF 做一次「生成 Java 源码」计时，记录版本与环境，作为基线；只记录数字，不复制产物入库。
- **报告格式**：机器型号/负载、release/debug、冷/热、P50/P95/最大值；禁止用 debug 数据对外承诺。

### 12.5 性能问题的高风险点

| 风险 | 预防 |
|---|---|
| 每次生成重新扫模块目录/读配置 | 配置与索引按 mtime 缓存；模块扫描只在打开时做一次 |
| 每个产物重新遍历所有实体 | 预建索引；渲染器只接收自己的实体/枚举切片 |
| diff 对 100 个文件全量计算 | 只对选中文件算；其余显示增删改摘要 |
| 大文本跨 Tauri IPC 多次复制 | 单次批量返回 + 预览截断阈值；全文按需取 |
| 原子写触发杀毒扫描 | 只写变更文件；临时文件同目录；写后不立即全量 stat |
| 生成时顺带查 DB 漂移 | 漂移检查独立、异步、可跳过；生成路径零 DB |
| 进度事件过密 | 合并到 ≤10 次/秒，只发阶段与百分比 |

### 12.6 P0 验收追加项

- 上述预算表全部满足（release，典型语料）。
- 病态语料不出现无反馈等待 >1 s，且可取消。
- `timings` 字段在 UI 可查看（诊断用，不打扰普通用户）。
- 相同 BMF 第二次生成走 `unchanged` 快路径，≤500 ms。
- 性能门禁进入 CI；失败信息给出「哪个阶段、多少 ms、预算多少」。

---

## 13. 参考

本机证据：

- `D:\NC65\yonyou_studio_nc65_wending\Common\Core\plugins`（MDP/MDE/bmfplugin）
- `D:\NC65\yonyou_studio_nc65_wending\MDP\plugins`（code/sqlgen/pdmgen/publish/database）
- `D:\NC65\yonyou_studio_nc65_wending\MDE\plugins`（RAD 单据向导、billtype/coderule）
- `D:\tool\eclipsehy\dropins\yonyouplugins\plugins\NCMDP_6.5.0.201405291435.jar`
- `D:\ncc\1909home\ierp\metadata\{baseType,dbTypes,Features,Patterns,AccessorTemplate}.xml`
- 仓内既有调研：`docs/NCForge-元数据三期-调研与方案-2026-11-04.md`、`docs/NCForge-借鉴Eclipse行业插件-能力迁移方案-20261104.md`

外部资料（只作行为对照）：

- [NC65 主子表单据节点客开](https://blog.csdn.net/CL_Blog/article/details/139774235)：元数据发布 → 生成 Java 源码（4 个类）→ 生成建库 SQL 并执行。
- [NC65 使用 UAP 客开主子单据](https://m.blog.csdn.net/m0_46401054/article/details/142381039)：发布/生成 VO/建表流程与常见错误。
- [UAP 元数据模型开发：销售报价单教程](https://wenku.csdn.net/doc/61jddb55ko)：AggVO、BodyOfAggVOAccessor、Single/REF/ARRAY/LIST 类型样式。
- [元数据创建（MDP 资源管理器）](https://m.blog.csdn.net/qq_37117521/article/details/81230794)：三种代码风格、访问器、主属性。
- [NC 单据开发初学者手册](https://wk.baidu.com/view/93ad2f28f71fb7360b4c2e3f5727a5e9846a2716)：单据模板/查询模板/打印模板、VO/AggVO、UI 工厂。
