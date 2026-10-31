//! 真机快照：中间件启动参数与类路径的**段序**（E2 / E3 / E5）。
//!
//! 默认不跑（`#[ignore]`）：依赖本机 NC 安装目录与一份真实工程。
//! 它验的是三个「以前静默错、看不出来」的地方：
//!
//! 1. `-Duap.hotwebs` 必须是 `hotwebs/` 的**实扫结果**。以前写死 5 个，本机 18 个目录里
//!    有 13 个被 `log.warn("ignore hotwebs webapp …")` 静默跳过（含 NCC 主前端 `iwebap`
//!    与业务前端 `eyeapp`）——服务照样"启动成功"，只是页面 404。
//! 2. `-Dnc.server.name` 必须等于 `ierp/bin/prop.xml` 的 `<domain><server><name>`。
//!    以前不传，运行时退回默认 `server` ⇒ `work/<name>/` 与配置分叉，官方
//!    `stopServer.bat` 停不掉我们起的服务。本机实测值 `xuyserver`，`work/` 下却只有 `server/`。
//! 3. `external/classes`（二开覆盖类）与 `resources`（framework 热修复类）必须进 classpath，
//!    且 `resources` 必须**早于** `NCHOME/lib/*.jar`——顺序反了覆盖就不生效，等于没加。
//!
//! ```bash
//! cargo test --test launch_spec_live -- --ignored --nocapture --test-threads=1
//! ```
//!
//! NC home 用 `NC_HOME` 覆盖（默认 `D:\ncc\1909home`），工程用 `NC_WORKSPACE`。

use nc_forge::launch::{hotwebs_names, middleware_classpath, middleware_vm_args, DEFAULT_HEAP_MB};
use nc_forge::nc_home;
use std::path::PathBuf;

fn nc_home_dir() -> PathBuf {
    std::env::var_os("NC_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"D:\ncc\1909home"))
}

fn project_root() -> PathBuf {
    std::env::var_os("NC_WORKSPACE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\work\aier\EyePortal"))
}

/// 精确找**指定绝对路径**在 classpath 里的位置。
///
/// 不能用 `ends_with("resources")`：工程里同名目录一大把（`…/resources`），
/// 会命中一个位置极靠前的假目标，于是"顺序对不对"这个断言就变成了噪音。
fn pos_exact(cp: &[PathBuf], want: &PathBuf) -> Option<usize> {
    let norm = |p: &PathBuf| {
        p.to_string_lossy()
            .replace('\\', "/")
            .replace("//?/", "")
            .to_lowercase()
    };
    let want = norm(want);
    cp.iter().position(|p| norm(p) == want)
}

/// 找第一个满足谓词的位置（用于「任意一个 NCHOME/lib 下的 jar」这类兜底）。
fn pos_where(cp: &[PathBuf], f: impl Fn(&str) -> bool) -> Option<usize> {
    cp.iter().position(|p| {
        let s = p.to_string_lossy().replace('\\', "/").to_lowercase();
        f(&s)
    })
}

#[test]
#[ignore = "要本机 NC 安装目录"]
fn hotwebs_实扫覆盖_目录下全部_webapp() {
    let home = nc_home_dir();
    let dir = home.join("hotwebs");
    if !dir.is_dir() {
        eprintln!("跳过：{} 下没有 hotwebs", home.display());
        return;
    }
    let scanned = hotwebs_names(&home);
    let on_disk = std::fs::read_dir(&dir).unwrap().flatten().count();
    eprintln!(
        "hotwebs 实扫 {} 个（目录下共 {on_disk} 项）：{}",
        scanned.len(),
        scanned.join(",")
    );

    let args = middleware_vm_args(&home, DEFAULT_HEAP_MB);
    let arg = args
        .iter()
        .find(|a| a.starts_with("-Duap.hotwebs="))
        .expect("必须传 uap.hotwebs");
    eprintln!("{arg}");

    // 空串在白名单语义下等于「全不挂」，比少挂几个更糟
    assert!(
        arg.len() > "-Duap.hotwebs=".len(),
        "hotwebs 名单不能为空：{arg}"
    );
    for must in ["nccloud", "iwebap", "eyeapp"] {
        if dir.join(must).is_dir() {
            assert!(
                arg.contains(must),
                "{must} 在 hotwebs/ 下存在却没进白名单，它会被静默跳过：{arg}"
            );
        }
    }
}

#[test]
#[ignore = "要本机 NC 安装目录"]
fn 服务名与_prop_xml_一致() {
    let home = nc_home_dir();
    let configured = nc_home::read_server_name(&home);
    eprintln!("prop.xml 里的服务名：{configured:?}");

    let args = middleware_vm_args(&home, DEFAULT_HEAP_MB);
    let arg = args
        .iter()
        .find(|a| a.starts_with("-Dnc.server.name="))
        .expect("必须显式传服务名（跳过 Main 后没人替我们补）");
    eprintln!("{arg}");

    let want = format!(
        "-Dnc.server.name={}",
        configured
            .as_deref()
            .unwrap_or(nc_home::DEFAULT_SERVER_NAME)
    );
    assert_eq!(arg, &want, "启动参数与 prop.xml 必须一致，否则 work/ 分叉");

    // 现场真实分叉证据：work/ 下只有默认名目录，没有配置里的名字
    let work = home.join("work");
    if let (Ok(rd), Some(name)) = (std::fs::read_dir(&work), configured.as_deref()) {
        let dirs: Vec<String> = rd
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        eprintln!("work/ 下的服务器目录：{dirs:?}");
        if dirs.iter().any(|d| d == nc_home::DEFAULT_SERVER_NAME) && !dirs.iter().any(|d| d == name)
        {
            eprintln!("⇒ 复现了分叉：配置是 {name}，运行时却建了 server/");
        }
    }
}

#[test]
#[ignore = "要本机 NC 安装目录"]
fn external_classes_与_resources_在_lib_之前进入类路径() {
    let home = nc_home_dir();
    let proj = project_root();
    let cp = if proj.is_dir() {
        let classes = nc_forge::launch::project_class_dirs(&proj, &home, &[]);
        middleware_classpath(&home, &classes)
    } else {
        eprintln!("（工程 {} 不存在，只验 NC home 侧）", proj.display());
        middleware_classpath(&home, &[])
    };
    eprintln!("classpath 条目 {} 个", cp.len());

    let external = pos_exact(&cp, &home.join("external").join("classes"));
    let resources = pos_exact(&cp, &home.join("resources"));
    let lib_jar = pos_exact(&cp, &home.join("lib").join("fwserver.jar")).or_else(|| {
        // 没有 fwserver.jar 的安装：退而求其次，找任意 NCHOME/lib 下的 jar
        let lib = home
            .join("lib")
            .to_string_lossy()
            .replace('\\', "/")
            .to_lowercase();
        pos_where(&cp, |s| {
            s.starts_with(&lib) && s.ends_with(".jar") && !s[lib.len()..].contains('/')
        })
    });
    eprintln!("external/classes={external:?} resources={resources:?} lib/jar={lib_jar:?}");

    if home.join("external/classes").is_dir() {
        assert!(external.is_some(), "external/classes 存在却没进 classpath");
    }
    if home.join("resources").is_dir() {
        assert!(resources.is_some(), "resources/ 存在却没进 classpath");
    }
    if let (Some(r), Some(l)) = (resources, lib_jar) {
        assert!(
            r < l,
            "resources 必须排在 lib 的 jar 之前才有覆盖效果（实际 {r} vs {l}）"
        );
    }
}
