//! NC home 识别：判断一个目录是不是能拿来启动服务的 NC 安装目录。
//!
//! 「NC home」是 NC 中间件的安装根目录（本机是 `D:\ncc\1909home`）：里面有 `modules`
//! （各业务模块，245 个）、`middleware`（中间件本体）、`lib` / `framework` / `external`
//! （公共 jar）、`ufjdk`（NC 自带的 JDK 1.8）。
//!
//! 为什么按内容识别而不是按目录名：同事的目录名五花八门（1909home、nchome、NC65、ierp…），
//! 按名字猜必然出错。判定只看「有没有这些东西」。
//!
//! 纯逻辑模块，不含 tauri 类型（原因见 workspace.rs 头注释）。

use serde::Serialize;
use std::path::{Path, PathBuf};

/// 中间件启动时按顺序找 java 的相对位置。第一个存在的胜出。
///
/// 只用 NC 自带的 ufjdk：NC65/1909 的中间件是 1.8 编译的，用机器上别处的
/// JDK 11/17 起不来（`UnsupportedClassVersionError` 或 Nashorn 缺失）。
const JAVA_CANDIDATES: [&str; 3] = [
    "ufjdk/bin/java.exe",
    "jdk/bin/java.exe",
    "jdk1.8/bin/java.exe",
];

/// 识别到的 NC home。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NcHome {
    /// 规范化后的根目录。
    pub root: String,
    /// 启动服务用的 java.exe（绝对路径）。
    pub java: String,
    /// `modules` 下的一级子目录数（业务模块数量）。
    pub module_count: usize,
    /// `bin/startup.bat` 里是否调 `nc.bs.mw.start.NCStarter`。
    ///
    /// 仅作信息展示：开发态启动走 `StartDirectServer`，用不着 NCStarter。
    /// 判它有没有，是为了在界面上区分「这是完整安装」还是「被裁剪过」。
    pub has_nc_starter: bool,
}

/// 找一个目录下的 java.exe。
pub fn find_java(root: &Path) -> Option<PathBuf> {
    JAVA_CANDIDATES
        .iter()
        .map(|rel| root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR)))
        .find(|p| p.is_file())
}

/// 扫盘时用的轻量判断：够像就够了，不读文件内容、不做完整校验。
///
/// 扫一个盘可能有上千个目录，每个都读 `startup.bat` 太贵；这里只看三个目录在不在。
pub fn looks_like_nc_home(dir: &Path) -> bool {
    find_java(dir).is_some()
        && dir.join("modules").is_dir()
        && dir.join("middleware").join("mw.jar").is_file()
}

/// 详细校验，失败时给出「缺什么」而不是笼统的「不是 NC home」。
///
/// 前端把这句文案直接显示给用户，所以每条都要能指导下一步动作。
pub fn probe(root: &Path) -> Result<NcHome, String> {
    if !root.is_dir() {
        return Err(format!("{} 不是一个目录", root.display()));
    }
    // 根目录可能带尾部分隔符或 `..`，统一成规范路径，后面拼 classpath 时前后缀才能对上。
    // 注意 canonicalize 在 Windows 上给的是 verbatim 路径（`\\?\D:\...`），必须剥掉——
    // 带 `?` 的路径拼进 `file:` URL 会变成 `file:///%3F/...`，Java 找不到任何 jar。
    let root = strip_verbatim(&std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf()));

    let java = find_java(&root).ok_or_else(|| {
        format!(
            "{} 下没有 ufjdk/bin/java.exe：这不是 NC 安装目录，或者安装包被裁剪过（NC 服务必须用自带的 1.8）",
            root.display()
        )
    })?;

    let modules = root.join("modules");
    if !modules.is_dir() {
        return Err(format!(
            "{} 下没有 modules 目录，不像 NC 安装目录",
            root.display()
        ));
    }
    if !root.join("middleware").join("mw.jar").is_file() {
        return Err(format!(
            "{} 下没有 middleware/mw.jar：中间件本体缺失，无法启动服务",
            root.display()
        ));
    }

    let module_count = count_subdirs(&modules);
    if module_count == 0 {
        return Err(format!("{} 是空的，没有任何业务模块", modules.display()));
    }

    Ok(NcHome {
        root: root.to_string_lossy().to_string(),
        java: java.to_string_lossy().to_string(),
        module_count,
        has_nc_starter: startup_bat_has_nc_starter(&root),
    })
}

/// 团队约定的默认 NC 安装目录。配置里没填时先试它。
///
/// 只在「没配置」时当候选，**不参与判定**——判定始终看内容（`probe`），
/// 所以同事把 NC 装在别处时，改配置即可，代码里不需要再加一个目录名。
pub const DEFAULT_NC_HOME: &str = r"D:\ncc\1909home";

/// 解析本次要用的 NC home：配置优先，没配就试默认位置。
///
/// 错误文案在 `probe` 的基础上补一句「去哪儿改」，因为这层通常直接显示在界面上。
pub fn resolve(configured: Option<&str>) -> Result<NcHome, String> {
    let configured = configured.map(str::trim).filter(|s| !s.is_empty());
    match configured {
        Some(path) => probe(Path::new(path)),
        None => probe(Path::new(DEFAULT_NC_HOME)).map_err(|e| {
            format!("{e}（默认位置是 {DEFAULT_NC_HOME}；可在「NC 服务」页选择你的 NC 安装目录）")
        }),
    }
}

/// NC 自己的服务器配置文件（相对 NC home）。
///
/// `bin/sysConfig.bat` 那个 GUI 改的就是它；`nc.bs.mw.fm.ServiceManager` 在没有
/// `-Dnc.server.prop` 时默认读 `./ierp/bin/prop.xml`（工作目录就是 NC home）。
/// 里面 `<http><port>` 是中间件监听端口，`<servicePort>` 是 Tomcat 的 shutdown 端口。
pub const SERVER_PROP: &str = "ierp/bin/prop.xml";

/// 读不到配置时的回落端口。NC 装好默认就是 80。
pub const DEFAULT_HTTP_PORT: u16 = 80;

/// 中间件监听端点，取自 `ierp/bin/prop.xml`。
///
/// 为什么必须读而不是写死 80：同一个 NC home 常被同事改过（80 被 IIS 占了换 8080，
/// 或者为了外网访问把 address 从 127.0.0.1 改成 0.0.0.0）。写死会让工具同时说两句错话——
/// 「端口空闲」而实际被别人的服务占着，「服务没起来」而实际日志都刷完了。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerEndpoints {
    /// `<http><port>`：中间件对外的监听端口。
    pub http_port: u16,
    /// `<http><address>`：`127.0.0.1` 表示只有本机能访问。
    pub http_address: Option<String>,
    /// `<servicePort>`：Tomcat 的 shutdown 端口，冲突时启动也会失败。
    pub service_port: Option<u16>,
    /// 读的是哪个文件（绝对路径），界面用来显示「端口从哪来」。
    pub config_path: String,
    /// 是否真的从文件读到了端口（false = 文件缺失/解析失败，用的是默认 80）。
    pub from_config: bool,
}

impl ServerEndpoints {
    /// 配置读不到时的兜底值。命令层在 NC home 都没定位到时也要能给出一个端点。
    pub fn fallback(config_path: impl Into<String>) -> Self {
        Self {
            http_port: DEFAULT_HTTP_PORT,
            http_address: None,
            service_port: None,
            config_path: config_path.into(),
            from_config: false,
        }
    }
}

/// 读中间件的监听端点。任何读/解析失败都回落到默认 80，不向上抛错——
/// 端点只用于「查端口、拼提示」，它失败不该让整个服务页打不开。
pub fn read_endpoints(root: &Path) -> ServerEndpoints {
    let path = root.join(SERVER_PROP.replace('/', std::path::MAIN_SEPARATOR_STR));
    let config_path = path.to_string_lossy().to_string();
    let Ok(bytes) = std::fs::read(&path) else {
        return ServerEndpoints::fallback(config_path);
    };
    // 文件声明 gb2312，但标签与端口号都是 ASCII；GB2312 的第二字节落在 0x40~0xFE，
    // 不可能等于 `<`(0x3C) 或 `>`(0x3E)，所以按文本找标签不会被中文注释带偏。
    let text = crate::workspace::decode_lossy(&bytes);

    // 只认 `<http>` 块里的 `<port>`：同一层还有 `<servicePort>`（shutdown 端口），
    // 在全文里找 `<port>` 会误命中 `<https>` 块（实测：只配 https 时会报 443），
    // 而 443 被当真后，界面说「443 空闲」、启动去查 443 的占用、改端口却找不到可改的项。
    // 所以**没有 `<http>` 块就当作读不到**，回落默认 80 并标记 from_config=false。
    let http = tag_block(&text, "http");
    // shutdown 端口单独解析：它与监听端口是两回事，缺了 http 块也要能报出来
    // （8005 被占时中间件同样起不来，排查时用得上）。
    let service_port = tag_text(&text, "servicePort").and_then(|v| v.parse::<u16>().ok());
    let Some(body) = http else {
        return ServerEndpoints {
            service_port,
            ..ServerEndpoints::fallback(config_path)
        };
    };
    let address = tag_text(body, "address").map(str::to_string);
    let Some(port) = tag_text(body, "port")
        .and_then(|v| v.parse::<u16>().ok())
        .filter(|p| *p > 0)
    else {
        return ServerEndpoints {
            service_port,
            ..ServerEndpoints::fallback(config_path)
        };
    };
    ServerEndpoints {
        http_port: port,
        http_address: address,
        service_port,
        config_path,
        from_config: true,
    }
}

/// 取 `<tag>值</tag>` 的值（去掉两侧空白）。找不到返回 None。
fn tag_text<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].trim())
}

/// 取 `<tag ...>…</tag>` 之间的内容，开标签允许带属性。
fn tag_block<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let marker = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut from = 0usize;
    while let Some(i) = xml[from..].find(&marker) {
        let at = from + i;
        let after_tag = &xml[at + marker.len()..];
        // `<http>` 与 `<https>` 前缀相同，必须看紧跟其后的字符
        let boundary = after_tag
            .chars()
            .next()
            .is_some_and(|c| c == '>' || c.is_whitespace());
        if boundary {
            if let Some(gt) = after_tag.find('>') {
                let body = at + marker.len() + gt + 1;
                if let Some(e) = xml[body..].find(&close) {
                    return Some(&xml[body..body + e]);
                }
            }
        }
        from = at + marker.len();
    }
    None
}

/// 去掉 Windows 的 `\\?\`（verbatim）前缀。
///
/// `std::fs::canonicalize` 在 Windows 上返回 `\\?\D:\...`。这种路径直接拼进 `file:` URL
/// 会变成 `file:///%3F/D:/...`——`?` 被百分号编码，Java 认为这是不存在的目录，
/// classpath 里 7000 个 jar 全部失效，报「找不到主类」。剥掉后才是 `file:/D:/...`。
///
/// 只处理「盘符」与 `UNC\` 两种形态，其余原样返回（非 Windows 上也安全）。
pub fn strip_verbatim(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    let Some(rest) = s.strip_prefix(r"\\?\") else {
        return path.to_path_buf();
    };
    // 盘符形式：`\\?\D:\ncc`
    if rest.as_bytes().get(1) == Some(&b':') {
        return PathBuf::from(rest);
    }
    // 网络路径形式：`\\?\UNC\server\share`
    if let Some(unc) = rest.strip_prefix(r"UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    path.to_path_buf()
}

fn count_subdirs(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries.flatten().filter(|e| e.path().is_dir()).count()
}

/// `bin/startup.bat` 是否调 NCStarter。读不到（没有这个文件、编码怪）一律当 false。
fn startup_bat_has_nc_starter(root: &Path) -> bool {
    let path = root.join("bin").join("startup.bat");
    match std::fs::read(&path) {
        // bat 可能是 GBK（中文注释），这里只找 ASCII 关键字，按 lossy 解码就够
        Ok(bytes) => String::from_utf8_lossy(&bytes).contains("nc.bs.mw.start.NCStarter"),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("ncforge-home-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// 造一个「长得像」的 NC home：只建判定要用的文件，不塞真 jar。
    fn fake_home(tag: &str) -> PathBuf {
        let d = temp_dir(tag);
        fs::create_dir_all(d.join("ufjdk").join("bin")).unwrap();
        fs::write(d.join("ufjdk").join("bin").join("java.exe"), b"stub").unwrap();
        fs::create_dir_all(d.join("middleware")).unwrap();
        fs::write(d.join("middleware").join("mw.jar"), b"stub").unwrap();
        for m in ["gl", "ic", "pu"] {
            fs::create_dir_all(d.join("modules").join(m)).unwrap();
        }
        d
    }

    fn cleanup(d: &Path) {
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn 完整目录能识别出模块数与自带的_java() {
        let d = fake_home("ok");
        let home = probe(&d).expect("应当识别成功");
        assert_eq!(home.module_count, 3);
        assert!(home.java.ends_with("java.exe"));
        assert!(!home.has_nc_starter, "没写 startup.bat 时应当是 false");
        cleanup(&d);
    }

    #[test]
    fn 缺_ufjdk_时提示指向_java() {
        let d = fake_home("no-jdk");
        fs::remove_dir_all(d.join("ufjdk")).unwrap();
        let err = probe(&d).unwrap_err();
        assert!(err.contains("ufjdk"), "错误文案要指出缺的是 ufjdk：{err}");
        cleanup(&d);
    }

    #[test]
    fn 缺_mw_jar_时提示指出中间件缺失() {
        let d = fake_home("no-mw");
        fs::remove_file(d.join("middleware").join("mw.jar")).unwrap();
        let err = probe(&d).unwrap_err();
        assert!(err.contains("mw.jar"), "{err}");
        cleanup(&d);
    }

    #[test]
    fn modules_为空时拒绝() {
        let d = fake_home("empty-modules");
        fs::remove_dir_all(d.join("modules")).unwrap();
        fs::create_dir_all(d.join("modules")).unwrap();
        assert!(probe(&d).is_err());
        cleanup(&d);
    }

    #[test]
    fn 传入文件而不是目录时拒绝() {
        let d = fake_home("file");
        let f = d.join("middleware").join("mw.jar");
        let err = probe(&f).unwrap_err();
        assert!(err.contains("不是一个目录"), "{err}");
        cleanup(&d);
    }

    #[test]
    fn 能读出_startup_bat_里的启动主类() {
        let d = fake_home("starter");
        fs::create_dir_all(d.join("bin")).unwrap();
        fs::write(
            d.join("bin").join("startup.bat"),
            b"@echo off\r\ncall java nc.bs.mw.start.NCStarter %*\r\n",
        )
        .unwrap();
        assert!(probe(&d).unwrap().has_nc_starter);
        cleanup(&d);
    }

    #[test]
    fn 剥掉_canonicalize_带来的_verbatim_前缀() {
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\D:\ncc\1909home")),
            PathBuf::from(r"D:\ncc\1909home")
        );
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\UNC\srv\share\ncc")),
            PathBuf::from(r"\\srv\share\ncc"),
            "UNC 要还原成普通网络路径"
        );
        // 没有前缀时原样返回，别把正常路径改坏
        assert_eq!(
            strip_verbatim(Path::new(r"D:\ncc\1909home")),
            PathBuf::from(r"D:\ncc\1909home")
        );
    }

    #[test]
    fn 轻量判断只看三样东西() {
        let d = fake_home("light");
        assert!(looks_like_nc_home(&d));
        fs::write(d.join("middleware").join("mw.jar"), b"").unwrap();
        assert!(looks_like_nc_home(&d), "mw.jar 存在即可，内容不检查");
        fs::remove_file(d.join("middleware").join("mw.jar")).unwrap();
        assert!(!looks_like_nc_home(&d));
        cleanup(&d);
    }

    #[test]
    fn resolve_优先用配置的目录() {
        let d = fake_home("resolve");
        let home = resolve(Some(d.to_str().unwrap())).expect("配置的目录有效时应当用它");
        let expect = strip_verbatim(&fs::canonicalize(&d).unwrap());
        assert_eq!(PathBuf::from(&home.root), expect);
        cleanup(&d);
    }

    /// 配置指向坏目录时必须报错，**不能**悄悄回落到默认位置：
    /// 否则用户以为自己选了 A，实际在跑 B 的 NC，日志和类都对不上。
    #[test]
    fn resolve_配置无效时直接报错而不回落() {
        let d = temp_dir("resolve-bad");
        let err = resolve(Some(d.to_str().unwrap())).unwrap_err();
        assert!(err.contains("ufjdk"), "要指出缺什么：{err}");
        cleanup(&d);
    }

    #[test]
    fn 空白配置当成没配() {
        let d = fake_home("resolve-blank");
        // 空白串走默认位置；默认位置在本机不存在时就报错，但错误里一定提到默认路径
        match resolve(Some("   ")) {
            Ok(_) => {}
            Err(e) => assert!(e.contains(DEFAULT_NC_HOME), "{e}"),
        }
        cleanup(&d);
    }

    /// 照着真实 `ierp/bin/prop.xml` 的骨架写一份：外层有 `<servicePort>`，
    /// 里层 `<http>` 才有真正监听的 `<port>`，两者很容易混。
    fn write_prop(root: &Path, body: &str) {
        let dir = root.join("ierp").join("bin");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("prop.xml"), body.as_bytes()).unwrap();
    }

    fn prop_xml(port: &str, address: &str) -> String {
        format!(
            "<?xml version=\"1.0\" encoding='gb2312'?>\n\
             \t<root ClassType=\"nc.uap.plugin.studio.ui.preference.prop.PropInfo\">\n\
             \t\t<domain><server>\n\
             \t\t\t<name>xuyserver</name>\n\
             \t\t\t<servicePort>8005</servicePort>\n\
             \t\t\t<http>\n\
             \t\t\t\t<address>{address}</address>\n\
             \t\t\t\t<port>{port}</port>\n\
             \t\t\t</http>\n\
             \t\t</server></domain>\n\
             \t</root>\n"
        )
    }

    #[test]
    fn 端点按_prop_xml_读出端口与监听地址() {
        let d = fake_home("ep-ok");
        write_prop(&d, &prop_xml("80", "127.0.0.1"));
        let ep = read_endpoints(&d);
        assert_eq!(ep.http_port, 80);
        assert_eq!(ep.http_address.as_deref(), Some("127.0.0.1"));
        assert_eq!(
            ep.service_port,
            Some(8005),
            "shutdown 端口单独取，不能和监听端口混"
        );
        assert!(ep.from_config);
        assert!(ep.config_path.ends_with("prop.xml"));
        cleanup(&d);
    }

    /// 同事把端口改成 8080 是最常见的场景：工具必须跟着走，
    /// 否则会一边说「80 空闲」一边连不上 8080 的服务。
    #[test]
    fn 端口改成_8080_时能读出来() {
        let d = fake_home("ep-8080");
        write_prop(&d, &prop_xml("8080", "0.0.0.0"));
        let ep = read_endpoints(&d);
        assert_eq!(ep.http_port, 8080);
        assert_eq!(ep.http_address.as_deref(), Some("0.0.0.0"));
        cleanup(&d);
    }

    #[test]
    fn 配置文件缺失时回落默认_80_并标记来源不可信() {
        let d = fake_home("ep-missing");
        let ep = read_endpoints(&d);
        assert_eq!(ep.http_port, DEFAULT_HTTP_PORT);
        assert!(!ep.from_config);
        assert!(ep.http_address.is_none());
        cleanup(&d);
    }

    /// 只有 `<servicePort>` 没有 `<http>` 时不能把 shutdown 端口当监听端口。
    #[test]
    fn 没有_http_块时不拿_service_port_顶替() {
        let d = fake_home("ep-only-service");
        write_prop(
            &d,
            "<root><domain><server><servicePort>8005</servicePort></server></domain></root>",
        );
        let ep = read_endpoints(&d);
        assert_eq!(ep.http_port, DEFAULT_HTTP_PORT);
        assert_eq!(ep.service_port, Some(8005));
        assert!(!ep.from_config);
        cleanup(&d);
    }

    #[test]
    fn 端口非法时回落() {
        for bad in ["", "abc", "0", "99999", "-1"] {
            let d = fake_home(&format!("ep-bad-{}", bad.replace('-', "m")));
            write_prop(&d, &prop_xml(bad, "127.0.0.1"));
            assert_eq!(
                read_endpoints(&d).http_port,
                DEFAULT_HTTP_PORT,
                "端口 {bad:?} 应当被拒绝"
            );
            cleanup(&d);
        }
    }

    /// `<https>` 前缀与 `<http>` 相同，不能被当成 http 块取走端口。
    #[test]
    fn 不会把_https_块当_http_块() {
        let d = fake_home("ep-https");
        write_prop(
            &d,
            "<root><server><https><port>443</port></https>\
             <http><address>127.0.0.1</address><port>8080</port></http></server></root>",
        );
        assert_eq!(read_endpoints(&d).http_port, 8080);
        cleanup(&d);
    }

    /// 只有 `<https>`、没有 `<http>` 时要当作「读不到」，回落 80。
    /// 早期实现会在没有 http 块时退回全文找 `<port>`，把 443 当成监听端口，
    /// 界面据此宣称「443 空闲」，与实际监听端口完全是两回事。
    #[test]
    fn 只有_https_块时回落默认端口而不是拿_443() {
        let d = fake_home("ep-https-only");
        write_prop(
            &d,
            "<root><server><https><port>443</port></https>\
             <servicePort>8005</servicePort></server></root>",
        );
        let ep = read_endpoints(&d);
        assert_eq!(
            ep.http_port, DEFAULT_HTTP_PORT,
            "不能把 https 的 443 当监听端口"
        );
        assert!(!ep.from_config, "没读到 http 块就不能宣称端口可信");
        assert!(ep.http_address.is_none());
        assert_eq!(ep.service_port, Some(8005), "shutdown 端口仍要读出来");
        cleanup(&d);
    }

    /// 真实文件的编码声明是 gb2312；只要标签是 ASCII 就必须能解析。
    #[test]
    fn gb2312_声明不影响解析() {
        let d = fake_home("ep-gbk");
        let mut bytes = prop_xml("8090", "127.0.0.1").into_bytes();
        // 塞一段 GBK 中文注释（"服务器" = B7 FE CE F1），UTF-8 解码会失败
        bytes.extend_from_slice(b"<!-- \xB7\xFE\xCE\xF1\xC6\xF7 -->");
        let dir = d.join("ierp").join("bin");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("prop.xml"), &bytes).unwrap();
        assert_eq!(read_endpoints(&d).http_port, 8090);
        cleanup(&d);
    }
}
