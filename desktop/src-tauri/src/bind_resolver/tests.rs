//! `bind_resolver` 的单测（与 `mod.rs` 的生产代码分开放：体量红线 600 行）。
//!
//! 真机用例 `resolver_live` 需要本机 java + 桥 jar + jdtls plugins，
//! 三者缺一就打印跳过（`#[ignore]`，跑法见该测试的注释）。

use super::*;
use std::path::Path;

/// 退避公式与 `fast_decl::Holder` 逐档一致：60s 起、翻倍、封顶 10min。
/// 两边数字不一致，排查时会对不上「到底在退避多久」。
#[test]
fn 退避公式照抄_fast_decl() {
    let d = |n: u32| backoff_delay(n).as_secs();
    assert_eq!(d(1), 60);
    assert_eq!(d(2), 120);
    assert_eq!(d(3), 240);
    assert_eq!(d(4), 480);
    assert_eq!(d(5), 600, "30<<5=960，封顶 600");
    assert_eq!(d(9), 600, "再翻也封顶");
}

/// 空闲 TTL：刚用完不能砍，放够 120s 才退。
#[test]
fn 空闲_ttl_判定() {
    let now = Instant::now();
    assert!(!idle_expired(now, now), "刚用完不该退");
    assert!(!idle_expired(now - Duration::from_secs(119), now));
    assert!(idle_expired(now - Duration::from_secs(120), now));
    assert!(idle_expired(now - Duration::from_secs(600), now));
}

/// 影子工程 `.classpath`：src 拼工作区根、lib 原样、con/output 跳过、
/// `sourcepath` 不影响（jar 的源码附件不参与解析）。
#[test]
fn 影子工程_classpath_解析() {
    let xml = concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<classpath>\n",
        "  <classpathentry kind=\"src\" output=\"shadow-bin/gl\" path=\"gl/src/private\"/>\n",
        "  <classpathentry kind=\"con\" path=\"org.eclipse.jdt.launching.JRE_CONTAINER\"/>\n",
        "  <classpathentry kind=\"lib\" path=\"D:/nc/modules/gl/lib/a.jar\" sourcepath=\"D:/nc/a_src.jar\"/>\n",
        "  <classpathentry kind=\"output\" path=\"shadow-bin\"/>\n",
        "</classpath>\n",
    );
    let out = parse_shadow_classpath(xml, Path::new("C:/ws"));
    assert_eq!(
        out,
        vec![
            PathBuf::from("C:/ws/gl/src/private"),
            PathBuf::from("D:/nc/modules/gl/lib/a.jar"),
        ]
    );
}

/// 三处退场钩子（jdt.ls ServiceReady / 关软件 / 切工作区）都是**无条件**调
/// `shutdown`：没起过进程时必须是无害 no-op——HOLDER 尚未初始化不能 panic，
/// 已初始化但 worker 已走（正常退出路径）也不能误伤。这条钉的就是「钩子可以
/// 无条件挂、调用方不必先判有没有 worker」这个契约。
#[test]
fn shutdown_无条件调用是无害noop() {
    shutdown();
    shutdown();
    // 进程内若另有用例起过 Holder，两次调用后状态必须回到 idle
    assert_ne!(status().state, "ready", "shutdown 之后不许仍处于 ready");
}

fn live_env() -> Option<(PathBuf, PathBuf, Vec<PathBuf>)> {
    let home = [
        PathBuf::from("D:/ncc/1909home"),
        PathBuf::from("C:/ncc/1909home"),
    ]
    .into_iter()
    .find(|p| p.is_dir())?;
    let java = home.join("ufjdk").join("bin").join("java.exe");
    let res = Path::new(env!("CARGO_MANIFEST_DIR"));
    let bridge = res.join("resources").join("ecj-bridge").join("ncecj.jar");
    let plugins_dir = res.join("resources").join("jdtls").join("plugins");
    let mut plugins: Vec<PathBuf> = std::fs::read_dir(&plugins_dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jar"))
        .collect();
    plugins.sort();
    (!plugins.is_empty()).then_some((java, bridge, plugins))
}

const PARENT: &str = "package probe;\n\npublic class Parent {\n    protected String label = \"p\";\n    public static final String TAG = \"t\";\n\n    public String greet(String who) {\n        return label + who;\n    }\n}\n";
const CHILD: &str = "package probe;\n\npublic class Child extends Parent {\n    public void run() {\n        String local = \"x\";\n        Child p = new Child();\n        System.out.println(p.greet(local));\n        System.out.println(p.label);\n        System.out.println(Parent.TAG);\n    }\n}\n";

/// 真机：合成工程上跑通「起进程 → init → resolve → 缓存命中 → invalidate →
/// 冷重建」全链路，并钉住三种 kind 的归属。
///
/// 与 `tools/index-probe/resolver-smoke.py` 的合成部分是同一组用例；这边多验的
/// 是 Rust 侧装配（BridgeEnv / plugins classpath / escape / argsFile）。
/// 跑法：`node scripts/rust-gate.mjs test --lib -- --ignored resolver_live --nocapture`
#[test]
#[ignore]
fn resolver_live() {
    let Some((java, bridge, plugins)) = live_env() else {
        println!("跳过：本机没有 java / 桥 jar / jdtls plugins");
        return;
    };
    let work = crate::test_support::tmp("bind-live");
    let _ = std::fs::remove_dir_all(&work);
    let src = work.join("src").join("probe");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("Parent.java"), PARENT).unwrap();
    let child = src.join("Child.java");
    std::fs::write(&child, CHILD).unwrap();
    // 影子工程的 .classpath：一个源根就够（resolver 只解析传递闭包）
    let cfg = work.join("cfg");
    std::fs::create_dir_all(cfg.join("lang").join("shadow")).unwrap();
    std::fs::write(
        cfg.join("lang").join("shadow").join(".classpath"),
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<classpath>\n  <classpathentry kind=\"src\" path=\"src\"/>\n</classpath>\n",
    )
    .unwrap();

    let env = ResolverEnv {
        java,
        bridge,
        plugins,
        config_dir: cfg,
        workspace_root: work.clone(),
        nc_root: work.clone(),
    };
    let text = std::fs::read_to_string(&child).unwrap();
    let off = |needle: &str, at: usize| text.find(needle).expect("用例串没找到") + at;

    let hit = resolve(&env, &child, off("p.label", 2)).expect("p.label 应答上来");
    assert_eq!(hit.kind, "field", "继承字段");
    assert_eq!(hit.fqcn.as_deref(), Some("probe.Parent"));
    assert_eq!(hit.name, "label");

    // CU 缓存命中：同文件同内容，结果一致
    let again = resolve(&env, &child, off("p.label", 2)).expect("第二次应答上来");
    assert_eq!(again.name, "label");

    // 静态链点字段 vs 点类型名（后者交回内容搜索）
    let tag = resolve(&env, &child, off("Parent.TAG", 7)).expect("TAG 应答上来");
    assert_eq!((tag.kind.as_str(), tag.name.as_str()), ("field", "TAG"));
    assert!(
        resolve(&env, &child, off("Parent.TAG", 0)).is_none(),
        "点类型名没有 per-token 绑定，应回 null"
    );

    assert_eq!(status().state, "ready");

    // invalidate 后冷走全流程，结果仍一致
    invalidate(&env, std::slice::from_ref(&child));
    let cold = resolve(&env, &child, off("p.label", 2)).expect("冷重建后应答得上");
    assert_eq!(cold.name, "label");
    assert_eq!(status().state, "ready");

    shutdown();
    assert_eq!(status().state, "idle", "shutdown 后回到 idle");
    let _ = std::fs::remove_dir_all(&work);
}
