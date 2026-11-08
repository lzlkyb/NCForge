//! M3 发布探针：只读地判断「这台机器能不能按 NC 官方流程做一次单组件发布 POC」，
//! 并产出一份可粘贴的操作手册。
//!
//! 三条边界，写死在实现里：
//! 1. **不连数据库**：探针只看文件系统；「指向的是不是测试库」必须由人确认，
//!    程序没法从 `prop.xml` 的密码字段判断库的性质，硬猜等于给假绿灯。
//! 2. **不调用发布接口**：发布走 UAP Studio / 官方工具，本模块只检查前置条件。
//! 3. **不写 NC 安装目录**：连「写权限试探」都不做——失败一次就在别人机器上留垃圾。

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::bmf_nchome;
use crate::nc_home;

/// 探针结论。`ok` 可以继续，`warn` 要人确认，`block` 必须先把这一项解决。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: String,
    pub label: String,
    pub status: String,
    pub detail: String,
    pub hint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub nc_home: Option<String>,
    pub component: String,
    pub module: String,
    pub checks: Vec<Check>,
    /// 阻断项数量。>0 时前端不给「可以开始」的判词。
    pub blockers: usize,
    pub warnings: usize,
    pub ready: bool,
    pub manual: String,
}

fn check(
    id: &str,
    label: &str,
    status: &str,
    detail: impl Into<String>,
    hint: impl Into<String>,
) -> Check {
    Check {
        id: id.to_string(),
        label: label.to_string(),
        status: status.to_string(),
        detail: detail.into(),
        hint: hint.into(),
    }
}

/// 运行探针。`bmf_path` 是准备发布的那一个组件文件（可空，空则跳过文件检查）。
///
/// `component` / `module` 只用于文案与路径提示，不做存在性推断：
/// 自定义模块的目录名不一定等于 ownModule。
pub fn probe(
    nc_home_cfg: Option<&str>,
    component: &str,
    module: &str,
    bmf_path: Option<&str>,
) -> Probe {
    let mut checks = Vec::new();
    let mut root: Option<PathBuf> = None;

    match nc_home::resolve(nc_home_cfg) {
        Ok(home) => {
            let p = PathBuf::from(&home.root);
            checks.push(check(
                "nc-home",
                "NC 安装目录",
                "ok",
                format!("{}（{} 个业务模块）", home.root, home.module_count),
                "发布必须在目标 NC 环境本机做；远程共享盘上的 class 与元数据缓存路径可能对不上。",
            ));
            checks.push(check(
                "jdk",
                "NC 自带 JDK",
                "ok",
                home.java.clone(),
                "官方发布工具依赖 1.8；用系统 JDK 可能报 UnsupportedClassVersion。",
            ));
            let prop = p.join(nc_home::SERVER_PROP.replace('/', std::path::MAIN_SEPARATOR_STR));
            if prop.is_file() {
                checks.push(check(
                    "server-prop",
                    "服务配置 prop.xml",
                    "warn",
                    prop.display().to_string(),
                    "**请人工确认它指向测试库**。探针读不出「这是不是测试库」，也不会去连。",
                ));
            } else {
                checks.push(check(
                    "server-prop",
                    "服务配置 prop.xml",
                    "block",
                    format!("{} 不存在", prop.display()),
                    "没有服务配置就无法确认目标环境；先在 NC 的 sysConfig 里配好数据源。",
                ));
            }
            let module_dir = p.join("modules").join(module);
            if module.trim().is_empty() {
                checks.push(check(
                    "module-dir",
                    "目标模块",
                    "warn",
                    "未指定模块",
                    "发布前要确认组件落在哪个模块下；跨模块发布需要额外的模块依赖声明。",
                ));
            } else if module_dir.is_dir() {
                checks.push(check(
                    "module-dir",
                    "目标模块",
                    "ok",
                    module_dir.display().to_string(),
                    "组件的 .bmf 应位于该模块的 METADATA 下；生成向导会给出目标路径。",
                ));
            } else {
                checks.push(check(
                    "module-dir",
                    "目标模块",
                    "warn",
                    format!("{} 不存在", module_dir.display()),
                    "自定义模块常见于把工程链接进工作区的情况；确认模块编码是否拼错。",
                ));
            }
            root = Some(p);
        }
        Err(e) => {
            checks.push(check(
                "nc-home",
                "NC 安装目录",
                "block",
                e,
                "到设置 → 开发 →「NC 环境」页选择目标环境的 NC home（POC 请选测试环境）。",
            ));
        }
    }

    if let Some(path) = bmf_path.map(str::trim).filter(|s| !s.is_empty()) {
        let p = Path::new(path);
        if p.is_file() {
            checks.push(check(
                "bmf-file",
                "待发布组件",
                "ok",
                path.to_string(),
                "发布前先跑一次校验；有 error 级问题不要发。",
            ));
        } else {
            checks.push(check(
                "bmf-file",
                "待发布组件",
                "block",
                format!("{path} 不存在"),
                "先保存 BMF，再回来做发布 POC。",
            ));
        }
    } else {
        checks.push(check(
            "bmf-file",
            "待发布组件",
            "warn",
            "未指定组件文件",
            "POC 建议只发布一个改动最小的组件，出问题能快速回滚。",
        ));
    }

    checks.push(check(
        "official-tool",
        "官方发布入口",
        "warn",
        "需要人工在 UAP Studio / 官方工具中执行",
        "NCForge 不自动发布：发布动作会改数据库元数据与缓存，一旦自动化就把「可回滚」变成「不可控」。",
    ));

    let blockers = checks.iter().filter(|c| c.status == "block").count();
    let warnings = checks.iter().filter(|c| c.status == "warn").count();
    let manual = manual(component, module, root.as_deref());
    Probe {
        nc_home: root.map(|p| p.to_string_lossy().into_owned()),
        component: component.to_string(),
        module: module.to_string(),
        checks,
        blockers,
        warnings,
        ready: blockers == 0,
        manual,
    }
}

/// 操作手册：直接给用户照做，不要求他再回来读代码或猜顺序。
pub fn manual(component: &str, module: &str, nc_home: Option<&Path>) -> String {
    let comp = if component.trim().is_empty() {
        "<组件编码>"
    } else {
        component.trim()
    };
    let module = if module.trim().is_empty() {
        "<模块>"
    } else {
        module.trim()
    };
    let home = nc_home
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "<NC home>".to_string());
    format!(
        r#"# 单组件发布 POC 操作手册（{comp}）

> 本手册由 NCForge 生成。NCForge **不执行发布**、**不连数据库**；发布动作由人在官方工具里完成。
> 目标：在测试环境验证「自研 BMF → 建表 → 发布 → 运行时能取到 VO 元数据」这条链，而不是上线功能。

## 0. 前置

- 目标环境：`{home}`（测试库；动手前再确认一遍 `ierp/bin/prop.xml` 指向的不是生产库）。
- 组件：`{comp}`，模块：`{module}`。
- 只发这一个组件；同批次其他改动先留在工作区，方便对照。

## 1. 备份（不可跳过）

1. 复制 `modules/{module}/METADATA/{comp}.bmf` 到工作区外的备份目录。
2. 复制对应的 `*VO.java`、`*BVO.java`（若本次改过）。
3. 记录当前版本号与文件 SHA-256；NCForge 的「保存」也会自动备份到 `bmf_backup/`，两处都留。
4. 数据库侧：对目标表做一次 `create table ... as select` 或导出 DDL+数据。

## 2. 建表（可选，按环境约定）

1. 在 NCForge 元数据页打开该组件 → 预览 → 复制 Oracle DDL。
2. 逐行 diff 后再在**测试库**执行；NC 发布通常不自动建表。
3. 执行后核对列名、类型、主键约束与预览一致。

## 3. 官方发布

1. 用目标环境的 UAP Studio（或 NC 官方元数据发布工具）打开 `{comp}.bmf`。
2. 选择「发布元数据 / 生成 VO」到**测试环境**，只勾选这一个组件。
3. 观察控制台：出现异常就停下，保留完整日志，不要连续重试。

## 4. 验证

1. 重启测试环境客户端/服务（元数据缓存按启动加载）。
2. 打开一张使用该组件的单据，确认能正常打开、保存。
3. 运行时抽查：
   - `VOMetaFactory.getInstance().getVOMeta("{module}.{comp}HVO")` 能取到表头元数据；
   - 表头/表体字段数量与 BMF 一致；
   - 新增/改名的字段在界面上可见（若界面模型已引用）。
4. 记录实际结果（成功/失败、报错原文、截图），写进可行性报告。

## 5. 回滚

1. 停测试环境客户端/服务。
2. 用第 1 步的备份覆盖 `.bmf` 与 VO 源文件。
3. 在官方工具里对回滚后的组件再发布一次（清掉缓存的错误元数据）。
4. 数据库侧按第 1 步的备份恢复；不要用 `drop table` 代替恢复。
5. 重启并复查第 4 步的验证项。

## 6. 可行性报告的结论口径

- **可行**：第 3、4 步一次通过，且回滚演练成功。
- **有条件可行**：需要人工补建表/改界面模型，但发布与运行时读取正常。
- **不可行**：官方工具拒绝自研 BMF（结构/ID/校验不通过），或发布后运行时报元数据缺失且无法定位。

把第 4 步的原始证据附在结论后面；没有证据的「可行」不算数。
"#
    )
}

// ── M6 发布编排骨架 ──
//
// 骨架只负责：把「能做自动检查的」与「必须人做的」分清楚、给出顺序、留下证据。
// **没有自动发布**：`Plan::auto_publish` 恒为 false；官方入口确认并演练通过之前，
// 界面上不出现「一键发布」这种按钮，避免把「检查通过」误读成「已经能发」。

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub id: String,
    pub label: String,
    /// found | missing | unknown（unknown = 无法从 NC home 判断，需人工确认）
    pub status: String,
    pub path: Option<String>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub id: String,
    pub title: String,
    /// auto = 工具只读检查；manual = 必须由人在官方工具/数据库侧执行
    pub mode: String,
    /// ready | blocked | pending
    pub status: String,
    pub detail: String,
    pub hint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub nc_home: Option<String>,
    pub component: String,
    pub module: String,
    pub tools: Vec<Tool>,
    pub steps: Vec<Step>,
    pub blockers: usize,
    pub warnings: usize,
    pub ready: bool,
    /// 骨架阶段固定 false。只有官方入口确认、自动发布的失败路径与回滚演练通过后才允许改。
    pub auto_publish: bool,
    /// 安装目录里的同名组件（没有 = 首次发布）。
    pub install_copy: Option<String>,
    pub workspace_sha256: Option<String>,
    pub install_sha256: Option<String>,
    /// 证据记录模板（Markdown），与 `evidence_markdown` 同一套字段。
    pub evidence_template: String,
}

fn tool(id: &str, label: &str, path: Option<&Path>, note_found: &str, note_missing: &str) -> Tool {
    let found = path.is_some_and(|p| p.exists());
    Tool {
        id: id.to_string(),
        label: label.to_string(),
        status: if found { "found" } else { "missing" }.to_string(),
        path: path.map(|p| p.to_string_lossy().into_owned()),
        note: if found {
            note_found.to_string()
        } else {
            note_missing.to_string()
        },
    }
}

fn read_sha(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(crate::bmf_write::sha256(&bytes))
}

/// 生成发布编排计划：官方工具探测 + 前置检查 + 步骤 + 证据模板。
///
/// `bmf_path` 是准备发布的工作区文件（可空）。全程只读：不连库、不调用发布接口、
/// 不写 NC 安装目录。
pub fn plan(
    nc_home_cfg: Option<&str>,
    component: &str,
    module: &str,
    bmf_path: Option<&str>,
) -> Plan {
    let component = component.trim().to_string();
    let module = module.trim().to_string();
    let probe = probe(nc_home_cfg, &component, &module, bmf_path);
    let home = nc_home::resolve(nc_home_cfg).ok();
    let root = home.as_ref().map(|h| PathBuf::from(&h.root));

    let mut tools = Vec::new();
    if let Some(home) = &home {
        let base = PathBuf::from(&home.root);
        tools.push(Tool {
            id: "nc-home".into(),
            label: "NC 安装目录".into(),
            status: "found".into(),
            path: Some(home.root.clone()),
            note: format!("{} 个业务模块", home.module_count),
        });
        tools.push(Tool {
            id: "java".into(),
            label: "NC 自带 JDK".into(),
            status: "found".into(),
            path: Some(home.java.clone()),
            note: "官方发布工具依赖 1.8".into(),
        });
        tools.push(tool(
            "mw",
            "中间件 mw.jar",
            Some(&base.join("middleware").join("mw.jar")),
            "中间件本体在位",
            "缺 middleware/mw.jar：安装包不完整",
        ));
        tools.push(tool(
            "prop",
            "服务配置 prop.xml",
            Some(&base.join("ierp").join("bin").join("prop.xml")),
            "端口与数据源配置；指向哪个库必须人工确认",
            "缺 prop.xml：无法确认目标环境",
        ));
        tools.push(tool(
            "start",
            "官方启动脚本",
            Some(&base.join("bin").join("startup.bat")),
            "存在；发布后需重启服务加载元数据缓存",
            "没用 bin/startup.bat 启动服务：重启方式以现场为准",
        ));
        tools.push(tool(
            "stop",
            "官方停止脚本",
            Some(&base.join("bin").join("stopServer.bat")),
            "存在",
            "未找到 bin/stopServer.bat（不同版本的脚本名可能不同），停止方式以现场为准",
        ));
        tools.push(tool(
            "module",
            "目标模块目录",
            Some(&base.join("modules").join(&module)),
            "组件应发布到该模块的 METADATA 下",
            "目标模块目录不存在：确认模块编码或先安装模块",
        ));
    } else {
        for (id, label, note) in [
            ("nc-home", "NC 安装目录", "先配置 NC home"),
            ("java", "NC 自带 JDK", "先配置 NC home"),
            ("mw", "中间件 mw.jar", "先配置 NC home"),
            ("prop", "服务配置 prop.xml", "先配置 NC home"),
            ("start", "官方启动脚本", "先配置 NC home"),
            ("stop", "官方停止脚本", "先配置 NC home"),
            ("module", "目标模块目录", "先配置 NC home"),
        ] {
            tools.push(Tool {
                id: id.into(),
                label: label.into(),
                status: "missing".into(),
                path: None,
                note: note.into(),
            });
        }
    }

    tools.push(Tool {
        id: "studio".into(),
        label: "官方发布入口（UAP Studio）".into(),
        status: "unknown".into(),
        path: None,
        note:
            "UAP Studio 是独立安装，无法从 NC home 判断是否存在；发布入口需人工确认，本工具不调用"
                .into(),
    });

    let install_copy = root
        .as_ref()
        .and_then(|r| bmf_nchome::find_candidates(r, &component, Some(&module)).ok())
        .and_then(|list| list.into_iter().next());
    tools.push(Tool {
        id: "install-copy".into(),
        label: "安装目录同名组件".into(),
        status: if install_copy.is_some() {
            "found"
        } else {
            "missing"
        }
        .into(),
        path: install_copy.as_ref().map(|c| c.path.clone()),
        note: if install_copy.is_some() {
            "覆盖发布前先备份这一份；结构差异可在「对比」页查看"
        } else {
            "安装目录里没有同名组件：首次发布，无需覆盖旧文件"
        }
        .into(),
    });

    let workspace_sha256 = bmf_path.and_then(|p| read_sha(Path::new(p)));
    let install_sha256 = install_copy
        .as_ref()
        .and_then(|c| read_sha(Path::new(&c.path)));

    let mut steps = Vec::new();
    steps.push(Step {
        id: "preflight".into(),
        title: "前置检查".into(),
        mode: "auto".into(),
        status: if probe.ready { "ready" } else { "blocked" }.into(),
        detail: format!("{} 项阻断，{} 项需人工确认", probe.blockers, probe.warnings),
        hint: "工具只读检查；阻断项解决前不要继续。".into(),
    });
    steps.push(Step {
        id: "backup".into(),
        title: "备份安装目录副本".into(),
        mode: "manual".into(),
        status: "pending".into(),
        detail: match &install_copy {
            Some(c) => format!(
                "复制 {} 到工作区外的备份目录，并记录 SHA-256 {}",
                c.path,
                install_sha256
                    .as_deref()
                    .map(|s| &s[..12.min(s.len())])
                    .unwrap_or("（读取失败）")
            ),
            None => "首次发布：安装目录没有旧文件；仍要备份数据库对象与本次改动的 VO 源文件".into(),
        },
        hint: "备份与发布是两件事；备份失败就不要继续。".into(),
    });
    steps.push(Step {
        id: "ddl".into(),
        title: "建表 / 核对 DDL（可选）".into(),
        mode: "manual".into(),
        status: "pending".into(),
        detail: "在元数据页生成 Oracle DDL 预览，逐行核对后在测试库执行".into(),
        hint: "NC 发布通常不自动建表；这步按环境约定做或跳过。".into(),
    });
    steps.push(Step {
        id: "publish".into(),
        title: "官方工具发布元数据".into(),
        mode: "manual".into(),
        status: "pending".into(),
        detail: format!(
            "在目标环境的 UAP Studio（或官方元数据发布工具）里发布 {component}，只勾选这一个组件"
        ),
        hint: "自动发布尚未接通：官方入口未确认，本工具不会调用任何发布接口。".into(),
    });
    steps.push(Step {
        id: "verify".into(),
        title: "运行时验证".into(),
        mode: "manual".into(),
        status: "pending".into(),
        detail: "重启服务后，用 VOMetaFactory 取表头/表体元数据，核对字段数与新增字段".into(),
        hint: "官方工具返回成功不算通过；以运行时能取到正确元数据为准。".into(),
    });
    steps.push(Step {
        id: "rollback".into(),
        title: "回滚准备 / 演练".into(),
        mode: "manual".into(),
        status: "pending".into(),
        detail: "用备份覆盖 .bmf 与 VO 源文件，在官方工具里重发一次清缓存".into(),
        hint: "未经演练的回滚计划不算证据；不要用 drop table 代替数据恢复。".into(),
    });

    let ready = root.is_some() && probe.blockers == 0;
    let mut out = Plan {
        nc_home: root.as_ref().map(|p| p.to_string_lossy().into_owned()),
        component,
        module,
        tools,
        steps,
        blockers: probe.blockers,
        warnings: probe.warnings,
        ready,
        auto_publish: false,
        install_copy: install_copy.as_ref().map(|c| c.path.clone()),
        workspace_sha256,
        install_sha256,
        evidence_template: String::new(),
    };
    out.evidence_template = evidence_markdown_raw(
        &out,
        "（时间待填）",
        "（待填：成功 / 失败 / 有条件通过）",
        "（执行人待填）",
        "（报错原文、运行时抽查结果、截图位置）",
    );
    out
}

/// 发布结果口径。只认三种，其余一律拒绝——避免「差不多成功」这类记录污染证据。
pub fn result_label(result: &str) -> Result<&'static str, String> {
    match result.trim().to_ascii_lowercase().as_str() {
        "success" => Ok("成功"),
        "failed" => Ok("失败"),
        "conditional" => Ok("有条件通过"),
        other => Err(format!(
            "发布结果只能是 success / failed / conditional，收到 {other:?}"
        )),
    }
}

/// 证据记录（Markdown）：把计划、文件名与 SHA、人工结论放在同一份里，便于直接贴给同事。
pub fn evidence_markdown(
    plan: &Plan,
    now_ms: u64,
    result: &str,
    operator: &str,
    note: &str,
) -> Result<String, String> {
    let label = result_label(result)?;
    let operator = operator.trim();
    if operator.is_empty() {
        return Err("执行人不能为空：没有执行人的记录不算证据".to_string());
    }
    Ok(evidence_markdown_raw(
        plan,
        &utc_stamp(now_ms),
        label,
        operator,
        note.trim(),
    ))
}

fn evidence_markdown_raw(
    plan: &Plan,
    stamp: &str,
    result: &str,
    operator: &str,
    note: &str,
) -> String {
    let home = plan.nc_home.as_deref().unwrap_or("（未识别）");
    let install = plan
        .install_copy
        .as_deref()
        .unwrap_or("（安装目录没有同名组件：首次发布）");
    let steps = plan
        .steps
        .iter()
        .enumerate()
        .map(|(i, s)| {
            format!(
                "{}. [{}] {}（{}）— {}",
                i + 1,
                s.status,
                s.title,
                s.mode,
                s.detail
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"# 发布证据：{comp}

- 时间：{stamp}
- 执行人：{operator}
- 目标 NC home：{home}
- 组件 / 模块：{comp} / {module}
- 工作区文件 SHA-256：{wsha}
- 安装目录副本：{install}
- 安装副本 SHA-256：{isha}
- 前置检查：{blockers} 项阻断，{warnings} 项需人工确认
- 发布结果：{result}

## 执行记录

{note}

## 步骤快照

{steps}

## 口径

- 本记录由 NCForge 生成，**不表示发布已由工具执行**；发布动作在官方工具里完成。
- 「成功」以运行时验证为准：VOMeta 能取到表头/表体、字段数与 BMF 一致。只有官方工具返回成功不算。
- 回滚演练结果要单独写清楚；没有演练过的回滚计划不算证据。
"#,
        comp = plan.component,
        module = plan.module,
        wsha = plan
            .workspace_sha256
            .as_deref()
            .unwrap_or("（未提供工作区文件）"),
        isha = plan.install_sha256.as_deref().unwrap_or("—"),
        blockers = plan.blockers,
        warnings = plan.warnings,
    )
}

/// 证据文件名里只保留 ASCII 标识符字符；组件编码之外的字符一律换成 `_`。
pub fn safe_file_stem(component: &str) -> String {
    let mut out: String = component
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() {
        out.push_str("component");
    }
    out
}

/// UTC 时间戳（文件名用）：`YYYYMMDD-HHMMSS`。
pub fn utc_stamp_compact(now_ms: u64) -> String {
    let (y, mo, d, h, mi, s) = utc_parts(now_ms);
    format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}")
}

/// UTC 时间戳（正文用）：`YYYY-MM-DD HH:MM:SS UTC`。
pub fn utc_stamp(now_ms: u64) -> String {
    let (y, mo, d, h, mi, s) = utc_parts(now_ms);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02} UTC")
}

fn utc_parts(now_ms: u64) -> (i32, u32, u32, u32, u32, u32) {
    let secs = now_ms / 1000;
    let days = (secs / 86_400) as i64;
    let rem = (secs % 86_400) as u32;
    let (y, mo, d) = civil_from_days(days);
    (y, mo, d, rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// 公历日期（Howard Hinnant 算法）：无时区依赖，测试可控。
fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y } as i32, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "ncforge-bmf-publish-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn missing_nc_home_blocks_but_still_writes_manual() {
        let p = probe(Some(r"Z:\definitely-not-here"), "sz02", "uapbd", None);
        assert!(!p.ready);
        assert!(p.blockers >= 1);
        assert!(p.manual.contains("SZ02") || p.manual.contains("sz02"));
        assert!(p.manual.contains("回滚"));
        assert!(p
            .checks
            .iter()
            .any(|c| c.id == "official-tool" && c.status == "warn"));
    }

    #[test]
    fn fake_nc_home_without_server_prop_is_not_ready() {
        let root = tmp("home");
        std::fs::create_dir_all(root.join("modules").join("uapbd")).unwrap();
        std::fs::create_dir_all(root.join("middleware")).unwrap();
        std::fs::write(root.join("middleware").join("mw.jar"), b"x").unwrap();
        std::fs::create_dir_all(root.join("ufjdk").join("bin")).unwrap();
        std::fs::write(
            root.join("ufjdk").join("bin").join(nc_home::JAVA_BIN_NAME),
            b"x",
        )
        .unwrap();
        let p = probe(Some(root.to_string_lossy().as_ref()), "sz02", "uapbd", None);
        assert!(!p.ready, "缺 prop.xml 必须阻挡");
        assert!(p
            .checks
            .iter()
            .any(|c| c.id == "server-prop" && c.status == "block"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn complete_fake_home_is_ready_but_still_warns_about_db() {
        let root = tmp("ready");
        std::fs::create_dir_all(root.join("modules").join("uapbd").join("METADATA")).unwrap();
        std::fs::create_dir_all(root.join("middleware")).unwrap();
        std::fs::write(root.join("middleware").join("mw.jar"), b"x").unwrap();
        std::fs::create_dir_all(root.join("ufjdk").join("bin")).unwrap();
        std::fs::write(
            root.join("ufjdk").join("bin").join(nc_home::JAVA_BIN_NAME),
            b"x",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("ierp").join("bin")).unwrap();
        std::fs::write(root.join("ierp").join("bin").join("prop.xml"), b"<x/>").unwrap();
        let p = probe(Some(root.to_string_lossy().as_ref()), "sz02", "uapbd", None);
        assert!(p.ready, "{:?}", p.checks);
        assert!(p
            .checks
            .iter()
            .any(|c| c.id == "server-prop" && c.status == "warn"));
        assert!(p.manual.contains("测试库"));
        let _ = std::fs::remove_dir_all(&root);
    }

    fn fake_release_home(tag: &str) -> PathBuf {
        let root = tmp(tag);
        let module = root.join("modules").join("uapbd");
        std::fs::create_dir_all(module.join("METADATA")).unwrap();
        std::fs::write(
            module.join("METADATA").join("demo.bmf"),
            b"<component name=\"demo\"/>",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("middleware")).unwrap();
        std::fs::write(root.join("middleware").join("mw.jar"), b"x").unwrap();
        std::fs::create_dir_all(root.join("ufjdk").join("bin")).unwrap();
        std::fs::write(
            root.join("ufjdk").join("bin").join(nc_home::JAVA_BIN_NAME),
            b"x",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("ierp").join("bin")).unwrap();
        std::fs::write(root.join("ierp").join("bin").join("prop.xml"), b"<x/>").unwrap();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::write(root.join("bin").join("startup.bat"), b"@echo off").unwrap();
        std::fs::write(root.join("bin").join("stopServer.bat"), b"@echo off").unwrap();
        root
    }

    #[test]
    fn plan_detects_tools_and_orders_steps_without_auto_publish() {
        let root = fake_release_home("plan");
        // `plan` 内部经 `nc_home::probe` 做 canonicalize（macOS `/var`→`/private/var`，
        // Windows 8.3 短名→长名），期望值必须走同一条路，否则比的是两种写法。
        let canon_root = nc_home::strip_verbatim(&std::fs::canonicalize(&root).unwrap());
        let ws = tmp("plan-ws");
        let ws_file = ws.join("demo.bmf");
        std::fs::write(
            &ws_file,
            b"<component name=\"demo\"><celllist/></component>",
        )
        .unwrap();

        let p = plan(
            Some(canon_root.to_string_lossy().as_ref()),
            "demo",
            "uapbd",
            Some(ws_file.to_string_lossy().as_ref()),
        );
        assert!(!p.auto_publish, "骨架阶段不允许自动发布");
        assert!(p.ready);
        for id in ["nc-home", "java", "mw", "prop", "start", "stop", "module"] {
            assert!(
                p.tools.iter().any(|t| t.id == id && t.status == "found"),
                "工具 {id} 应当被识别到：{:?}",
                p.tools
            );
        }
        assert!(p
            .tools
            .iter()
            .any(|t| t.id == "studio" && t.status == "unknown"));
        assert!(p
            .tools
            .iter()
            .any(|t| t.id == "install-copy" && t.status == "found"));
        let ids: Vec<&str> = p.steps.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "preflight",
                "backup",
                "ddl",
                "publish",
                "verify",
                "rollback"
            ]
        );
        assert_eq!(p.steps[0].status, "ready");
        assert!(p
            .steps
            .iter()
            .any(|s| s.id == "publish" && s.mode == "manual"));
        assert!(p.evidence_template.contains("不表示发布已由工具执行"));
        let expect_install = canon_root
            .join("modules")
            .join("uapbd")
            .join("METADATA")
            .join("demo.bmf")
            .to_string_lossy()
            .to_string();
        assert_eq!(p.install_copy.as_deref(), Some(expect_install.as_str()));
        assert!(p.workspace_sha256.is_some() && p.install_sha256.is_some());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn plan_without_nc_home_is_blocked_but_keeps_the_checklist() {
        let p = plan(Some(r"Z:\definitely-not-here"), "demo", "uapbd", None);
        assert!(!p.ready);
        assert!(p.blockers >= 1);
        assert!(p.nc_home.is_none());
        assert!(p.tools.iter().all(|t| t.status != "found"));
        assert_eq!(p.steps.len(), 6, "没有环境也要给出完整步骤");
        assert_eq!(p.steps[0].status, "blocked");
    }

    #[test]
    fn evidence_rejects_unknown_result_and_missing_operator() {
        let root = fake_release_home("evidence");
        let p = plan(Some(root.to_string_lossy().as_ref()), "demo", "uapbd", None);
        let err = evidence_markdown(&p, 0, "maybe", "张三", "").unwrap_err();
        assert!(err.contains("success"), "{err}");
        let err = evidence_markdown(&p, 0, "success", "   ", "").unwrap_err();
        assert!(err.contains("执行人"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn evidence_records_plan_hashes_and_runtime_caveat() {
        let root = fake_release_home("evidence-ok");
        let ws = tmp("evidence-ws");
        let ws_file = ws.join("demo.bmf");
        std::fs::write(&ws_file, b"<component name=\"demo\"/>").unwrap();
        let p = plan(
            Some(root.to_string_lossy().as_ref()),
            "demo",
            "uapbd",
            Some(ws_file.to_string_lossy().as_ref()),
        );
        let md =
            evidence_markdown(&p, 0, "conditional", "张三", "VOMeta 正常，字段少一个").unwrap();
        assert!(md.contains("# 发布证据：demo"));
        assert!(md.contains("1970-01-01 00:00:00 UTC"));
        assert!(md.contains("有条件通过"));
        assert!(md.contains("张三"));
        assert!(md.contains("VOMeta 正常"));
        assert!(md.contains("不表示发布已由工具执行"));
        assert!(md.contains("回滚"));
        assert_eq!(p.steps.len(), 6);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn stamps_are_utc_and_file_stem_is_sanitized() {
        assert_eq!(utc_stamp(0), "1970-01-01 00:00:00 UTC");
        assert_eq!(utc_stamp_compact(1_700_000_000_000), "20231114-221320");
        assert_eq!(safe_file_stem("demo"), "demo");
        assert_eq!(safe_file_stem(" a/b:c "), "a_b_c");
        assert_eq!(safe_file_stem("  "), "component");
    }
}
