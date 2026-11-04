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

fn check(id: &str, label: &str, status: &str, detail: impl Into<String>, hint: impl Into<String>) -> Check {
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
pub fn probe(nc_home_cfg: Option<&str>, component: &str, module: &str, bmf_path: Option<&str>) -> Probe {
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
                "到「NC 服务」页选择目标环境的 NC home（POC 请选测试环境）。",
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
    let comp = if component.trim().is_empty() { "<组件编码>" } else { component.trim() };
    let module = if module.trim().is_empty() { "<模块>" } else { module.trim() };
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
        assert!(p.checks.iter().any(|c| c.id == "official-tool" && c.status == "warn"));
    }

    #[test]
    fn fake_nc_home_without_server_prop_is_not_ready() {
        let root = tmp("home");
        std::fs::create_dir_all(root.join("modules").join("uapbd")).unwrap();
        std::fs::create_dir_all(root.join("middleware")).unwrap();
        std::fs::write(root.join("middleware").join("mw.jar"), b"x").unwrap();
        std::fs::create_dir_all(root.join("ufjdk").join("bin")).unwrap();
        std::fs::write(root.join("ufjdk").join("bin").join("java.exe"), b"x").unwrap();
        let p = probe(Some(root.to_string_lossy().as_ref()), "sz02", "uapbd", None);
        assert!(!p.ready, "缺 prop.xml 必须阻挡");
        assert!(p.checks.iter().any(|c| c.id == "server-prop" && c.status == "block"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn complete_fake_home_is_ready_but_still_warns_about_db() {
        let root = tmp("ready");
        std::fs::create_dir_all(root.join("modules").join("uapbd").join("METADATA")).unwrap();
        std::fs::create_dir_all(root.join("middleware")).unwrap();
        std::fs::write(root.join("middleware").join("mw.jar"), b"x").unwrap();
        std::fs::create_dir_all(root.join("ufjdk").join("bin")).unwrap();
        std::fs::write(root.join("ufjdk").join("bin").join("java.exe"), b"x").unwrap();
        std::fs::create_dir_all(root.join("ierp").join("bin")).unwrap();
        std::fs::write(root.join("ierp").join("bin").join("prop.xml"), b"<x/>").unwrap();
        let p = probe(Some(root.to_string_lossy().as_ref()), "sz02", "uapbd", None);
        assert!(p.ready, "{:?}", p.checks);
        assert!(p.checks.iter().any(|c| c.id == "server-prop" && c.status == "warn"));
        assert!(p.manual.contains("测试库"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
