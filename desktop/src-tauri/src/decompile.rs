//! jar 内类的反编译（CFR 0.152）。
//!
//! # 为什么需要
//!
//! jdt.ls 在 classpath 上找不到 `_src.jar` 时，`java/classFileContents` 给的是
//! **签名桩**——只有方法声明，正文是一句 `// Failed to get sources...`。NC 的
//! 标准库 9963 个 jar 里只有 27.8% 带源码（`uapbd` 213/221，`ic` 78/122），现场
//! 补丁包（`hyext`）更是几乎全裸，所以「跳进去看实现」这条路基本是断的。
//!
//! CFR 是单文件、无依赖、Java 8 即可运行的字节码反编译器，用它把 class 还原成
//! Java 源码，桩才有内容可读。
//!
//! # 边界（写进 UI 文案的那几条）
//!
//! - **不是原始源码**：局部变量名可能丢（编译时没带 `-g`），语法糖（lambda、
//!   switch-on-string、增强 for）会还原成展开形式，泛型信息只在签名可见处保留。
//! - **只看不写**：反编译产物是只读 model，和 `jdt://` 源码同一个待遇。
//! - 单个类一次 JVM 启动（实测 0.25 s）；整 jar 才 0.42 s，所以按需逐类跑不吃亏。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 单次反编译的上限。正常类 0.3 s 内出结果；卡到 60 s 说明 CFR 撞上了病态字节码
/// （超大的初始化方法、大量嵌套），继续等只会让前端一直转圈。
const TIMEOUT: Duration = Duration::from_secs(60);

/// 从 `jdt://` 地址解出的定位信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JdtClass {
    /// classpath 上的 jar 文件名（不含目录），如 `pubuapbd_aassign.jar`。
    pub jar_name: String,
    /// jar 内的条目路径，如 `nc/itf/bd/aassign/IAAssignMaintainService.class`。
    pub entry: String,
    /// 全限定类名（内部类保留 `$`）。
    pub fqcn: String,
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// `%20` 这类转义的最小解码。jar 名里带空格、中文时会用上。
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `jdt://contents/<jar 名>/<包路径>/<类名>.class?=<base64>` → 定位信息。
///
/// 只认 `contents` 这一种（jdt.ls 对 classpath 上的类只给这一种）。
/// 查询串是 jdt.ls 的私有附件（编码后的 project/classpath），与我们无关，丢掉。
pub fn parse_jdt_uri(uri: &str) -> Option<JdtClass> {
    let path = uri.split('?').next()?;
    let rest = path.strip_prefix("jdt://contents/")?;
    let (jar, entry) = rest.split_once('/')?;
    let entry = percent_decode(entry);
    if jar.is_empty() || !entry.ends_with(".class") {
        return None;
    }
    let fqcn = entry.trim_end_matches(".class").replace('/', ".");
    Some(JdtClass {
        jar_name: percent_decode(jar),
        entry,
        fqcn,
    })
}

/// 按文件名（不区分大小写）在候选里挑 jar。
///
/// 名字对得上就认：jdt.ls 只给文件名，同名 jar 在 NCHOME 里极少且内容通常一致，
/// 为「同名但不同版本」去做全量类扫描不值得——真挑错了，反编译出来的类名也会
/// 对不上，界面上看得出来。
pub fn pick_jar(jar_name: &str, candidates: &[PathBuf]) -> Option<PathBuf> {
    let want = jar_name.to_lowercase();
    candidates
        .iter()
        .find(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().to_lowercase() == want)
        })
        .cloned()
}

/// 跑 CFR，返回该类反编译出的 Java 源码。
///
/// 参数形式是 `<jar> <jar 内条目>`：给条目而只给类名，CFR 才会只输出那一个类
/// （只给类名时它会把整个 jar 打出来——实测 8 个类的 jar 就是 8 份源码拼在一起）。
pub fn run_cfr(java: &Path, cfr: &Path, jar: &Path, entry: &str) -> Result<String, String> {
    // A single CFR JVM bounds heap and pipe buffers across simultaneous navigation requests.
    static CFR_SLOT: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _slot = CFR_SLOT.lock().unwrap_or_else(|e| e.into_inner());
    // The process slot also coalesces identical concurrent requests through this bounded cache.
    type Cache = std::collections::VecDeque<(String, String)>;
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Cache>> = std::sync::OnceLock::new();
    let fingerprint = |p: &Path| -> Result<String, String> {
        let m = std::fs::metadata(p).map_err(|e| e.to_string())?;
        Ok(format!(
            "{:?}:{}:{:?}",
            p,
            m.len(),
            m.modified().map_err(|e| e.to_string())?
        ))
    };
    let cache_key = format!(
        "{}|{}|{}|{}",
        fingerprint(java)?,
        fingerprint(cfr)?,
        fingerprint(jar)?,
        entry
    );
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(Cache::new()));
    if let Some((_, source)) = cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|(key, _)| key == &cache_key)
    {
        return Ok(source.clone());
    }
    let _reservation = crate::process_budget::Reservation::acquire(512)?;
    let mut cmd = Command::new(java);
    // CFR 走 stdout 输出，`file.encoding` 决定它写出的编码；中文注释不能变乱码。
    cmd.args(["-Dfile.encoding=UTF-8", "-Xmx512m", "-jar"])
        .arg(cfr)
        .arg(jar)
        .arg(entry)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：不弹控制台窗口
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 java（{}）：{e}", java.display()))?;
    let mut out = child.stdout.take().ok_or("读取 CFR 输出失败")?;
    let mut err = child.stderr.take().ok_or("读取 CFR 输出失败")?;
    // 两个管道都要排空，否则输出量大时子进程会卡在写管道上等我们读
    let h_out = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = (&mut out).take(8 * 1024 * 1024 + 1).read_to_end(&mut b);
        let _ = std::io::copy(&mut out, &mut std::io::sink());
        b
    });
    let h_err = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = (&mut err).take(1024 * 1024 + 1).read_to_end(&mut b);
        let _ = std::io::copy(&mut err, &mut std::io::sink());
        b
    });
    let start = Instant::now();
    let status = loop {
        match child
            .try_wait()
            .map_err(|e| format!("等待 CFR 失败：{e}"))?
        {
            Some(st) => break st,
            None if start.elapsed() > TIMEOUT => {
                let _ = child.kill();
                // kill 之后必须 wait 回收：不 wait 的话子进程句柄留到 Child 被 drop，
                // 而两个读管道线程还在等 EOF，句柄关不掉就成了看不见的残留
                let _ = child.wait();
                let _ = h_out.join();
                let _ = h_err.join();
                return Err(format!(
                    "反编译超时（超过 {} 秒），已终止",
                    TIMEOUT.as_secs()
                ));
            }
            None => std::thread::sleep(Duration::from_millis(40)),
        }
    };
    let source = String::from_utf8_lossy(&h_out.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&h_err.join().unwrap_or_default()).into_owned();
    if source.len() > 8 * 1024 * 1024 || stderr.len() > 1024 * 1024 {
        return Err("反编译输出超过内存上限，请缩小输入范围".into());
    }
    if !status.success() && source.trim().is_empty() {
        let tail: String = stderr.lines().rev().take(3).collect::<Vec<_>>().join("；");
        return Err(if tail.is_empty() {
            format!("CFR 退出码 {}", status.code().unwrap_or(-1))
        } else {
            format!("CFR 反编译失败：{tail}")
        });
    }
    // CFR 找不到条目时照样退出 0，只在 stderr 抱怨；没有类声明的输出不能当源码
    if !looks_like_java(&source) {
        return Err(format!(
            "jar 里没有 {}（{}）",
            entry,
            jar.file_name().unwrap_or_default().to_string_lossy()
        ));
    }
    {
        let mut cached = cache.lock().unwrap_or_else(|e| e.into_inner());
        while cached.iter().map(|(_, text)| text.len()).sum::<usize>() + source.len()
            > 16 * 1024 * 1024
            || cached.len() >= 32
        {
            if cached.pop_front().is_none() {
                break;
            }
        }
        cached.push_back((cache_key, source.clone()));
    }
    Ok(source)
}

/// 粗判「这看起来是不是一份 Java 源码」。只用来识别 CFR 的空输出，不做语法分析。
fn looks_like_java(text: &str) -> bool {
    text.lines().any(|l| {
        let t = l.trim_start();
        t.starts_with("package ")
            || t.starts_with("public class ")
            || t.starts_with("public interface ")
            || t.starts_with("public enum ")
            || t.starts_with("class ")
            || t.starts_with("interface ")
            || t.starts_with("enum ")
            || t.starts_with("final class ")
            || t.starts_with("public final class ")
            || t.starts_with("@")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn 解析标准的类地址() {
        let c = parse_jdt_uri(
            "jdt://contents/pubuapbd_aassign.jar/nc/itf/bd/aassign/IAAssignMaintainService.class",
        )
        .unwrap();
        assert_eq!(c.jar_name, "pubuapbd_aassign.jar");
        assert_eq!(c.entry, "nc/itf/bd/aassign/IAAssignMaintainService.class");
        assert_eq!(c.fqcn, "nc.itf.bd.aassign.IAAssignMaintainService");
    }

    #[test]
    fn 丢掉查询串并保留内部类() {
        let c = parse_jdt_uri("jdt://contents/a.jar/p/Outer$Inner.class?=abc%3D%3D").unwrap();
        assert_eq!(c.jar_name, "a.jar");
        assert_eq!(c.entry, "p/Outer$Inner.class");
        assert_eq!(c.fqcn, "p.Outer$Inner");
    }

    #[test]
    fn jar_名里的转义会被解回来() {
        let c = parse_jdt_uri("jdt://contents/my%20lib.jar/p/A.class").unwrap();
        assert_eq!(c.jar_name, "my lib.jar");
    }

    #[test]
    fn 不是_jar_内的类就返回_none() {
        assert!(parse_jdt_uri("file:///C:/a/B.java").is_none());
        assert!(parse_jdt_uri("jdt://contents/a.jar/p/A.java").is_none());
        assert!(parse_jdt_uri("jdt://contents/a.jar").is_none());
        assert!(parse_jdt_uri("jdt://contents//p/A.class").is_none());
        // 残缺的 % 转义不能把解析带崩
        assert_eq!(
            parse_jdt_uri("jdt://contents/a%zz.jar/p/A.class")
                .unwrap()
                .jar_name,
            "a%zz.jar"
        );
    }

    #[test]
    fn 按文件名挑_jar_不区分大小写() {
        // 夹具用 `/` 而不是 `\`：`Path::file_name` 在 macOS/Linux 上不把反斜杠当
        // 分隔符，用 Windows 反斜杠写夹具会让整串都变成「文件名」而在这条用例上假红。
        // 被测的是「按文件名不区分大小写匹配」，与分隔符无关。
        let jars = vec![
            p("D:/ncc/1909home/lib/PubUapbd_aassign.jar"),
            p("D:/ncc/1909home/modules/uapbd/lib/other.jar"),
        ];
        assert_eq!(
            pick_jar("pubuapbd_aassign.jar", &jars),
            Some(p("D:/ncc/1909home/lib/PubUapbd_aassign.jar"))
        );
        assert_eq!(pick_jar("nope.jar", &jars), None);
        // 只比文件名，不拿目录里的字眼凑
        assert_eq!(pick_jar("uapbd.jar", &jars), None);
    }

    #[test]
    fn 空输出与错误行不算源码() {
        assert!(!looks_like_java(""));
        assert!(!looks_like_java("/* Decompiled with CFR 0.152. */\n"));
        assert!(looks_like_java("package a;\n\npublic class B {}\n"));
        assert!(looks_like_java("public interface C {\n}\n"));
        assert!(looks_like_java("public enum D { A }\n"));
    }
}

/// 真机快照：用 1909home 的 jar 与仓库里的 CFR 实跑一次。
///
/// `cargo test --lib -- --ignored 真实_jar` 才跑。放在这里而不是 `tests/`：
/// `cargo test --test <名>` 会重建主二进制，dev 时 `nc-forge.exe` 在跑就必然「拒绝访问」。
#[cfg(test)]
mod live_tests {
    use super::*;

    const NC_HOME: &str = r"D:\ncc\1909home";
    const JAR: &str = r"D:\ncc\1909home\modules\uapbd\lib\pubuapbd_aassign.jar";
    const URI: &str =
        "jdt://contents/pubuapbd_aassign.jar/nc/itf/bd/aassign/IAAssignMaintainService.class";

    #[test]
    #[ignore]
    fn 真实_jar_能反编译出源码() {
        let jar_all = Path::new(JAR);
        if !jar_all.is_file() {
            eprintln!("跳过：本机没有 {JAR}");
            return;
        }
        let java = Path::new(NC_HOME).join("ufjdk/bin/java.exe");
        let cfr = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/cfr/cfr-0.152.jar");
        assert!(cfr.is_file(), "仓库里缺 {}", cfr.display());

        let class = parse_jdt_uri(URI).unwrap();

        // 找 jar 的成本（NCHOME 全量 7000+ 个路径），用户每点一次都要付
        let t0 = std::time::Instant::now();
        let candidates = crate::nc_index::classpath_jars(Path::new(NC_HOME));
        let scan_ms = t0.elapsed().as_millis();
        let found = pick_jar(&class.jar_name, &candidates).expect("按文件名找不到 jar");
        assert_eq!(found, Path::new(JAR));

        let t1 = std::time::Instant::now();
        let source = run_cfr(&java, &cfr, &found, &class.entry).expect("反编译失败");
        let ms = t1.elapsed().as_millis();

        eprintln!(
            "候选 jar {} 个，找 jar {scan_ms} ms；反编译 {ms} ms；源码 {} 行",
            candidates.len(),
            source.lines().count()
        );
        eprintln!(
            "前 8 行：\n{}",
            source.lines().take(8).collect::<Vec<_>>().join("\n")
        );
        assert!(source.contains("IAAssignMaintainService"));
        assert!(source.contains("saveAAssignVO"));
    }
}
