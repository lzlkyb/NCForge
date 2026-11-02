//! 安全原语模块。
//!
//! 本壳子只保留**路径白名单**这一项：任何要把用户文件系统暴露给前端或远程的
//! 桌面应用都需要它（canonicalize + 祖先遍历 +  glob 匹配）。
//! 新增安全约束（令牌常量时间比较、限流、禁扩展名等）按主题在此目录新建文件，
//! 并在下面声明——与 cc-bridge 的 security/ 组织方式一致。

pub mod path;

/// 配置级安全口径的回归断言。
///
/// `tauri.conf.json` 与 capability 文件不在 Rust 类型系统里，改宽了不会编译失败——
/// 而这些恰恰是「前端被注入时能干什么」的总闸（CSP 管脚本来源，capability 管插件权限，
/// updater 传输协议管更新包从哪来）。这里的断言在读配置的单一出口上钉死最低口径，
/// 想放宽必须先改红一条测试，避免一次无关的配置整理顺手把闸门拆了。
#[cfg(test)]
mod posture {
    const TAURI_CONF: &str = include_str!("../../tauri.conf.json");
    const CAPABILITIES: &str = include_str!("../../capabilities/default.json");

    fn tauri_conf() -> serde_json::Value {
        serde_json::from_str(TAURI_CONF).expect("tauri.conf.json 不是合法 JSON")
    }

    #[test]
    fn csp_is_enforced_in_prod_and_dev() {
        let conf = tauri_conf();
        let security = &conf["app"]["security"];

        let csp = security["csp"]
            .as_str()
            .expect("生产 CSP 不能为 null（null = 关掉 XSS 最后一道闸）");
        for required in [
            "default-src 'self'",
            "script-src 'self'",
            "object-src 'none'",
            "base-uri 'self'",
            "connect-src ipc: http://ipc.localhost",
        ] {
            assert!(csp.contains(required), "生产 CSP 缺 `{required}`：{csp}");
        }
        // eval = 把字符串变代码执行，Monaco 用的核心与基础语言都不要它。
        assert!(
            !csp.contains("unsafe-eval"),
            "生产 CSP 不该放开 unsafe-eval：{csp}"
        );
        assert!(
            !csp.contains("script-src 'self' 'unsafe-inline'"),
            "生产 CSP 的内联脚本只应由构建期注入 hash/nonce 放行：{csp}"
        );

        // 开发态必须单独给：Vite 的 react-refresh 前导与 index.html 首帧脚本都是内联的，
        // 而 devUrl 的 HTML 不经过 Tauri 的 hash 注入。
        let dev = security["devCsp"]
            .as_str()
            .expect("devCsp 缺失会让开发态直接沿用生产 CSP，内联脚本被拦、界面白屏");
        assert!(
            dev.contains("script-src 'self' 'unsafe-inline'"),
            "devCsp 需要放行内联脚本：{dev}"
        );
        assert!(
            dev.contains("ws:") && dev.contains("http:"),
            "devCsp 需要放行 HMR 的 ws/http：{dev}"
        );
    }

    #[test]
    fn updater_refuses_plaintext_transport() {
        let conf = tauri_conf();
        let updater = &conf["plugins"]["updater"];
        assert_ne!(
            updater["dangerousInsecureTransportProtocol"],
            serde_json::json!(true),
            "更新包能落盘并执行，明文传输等于把签名前的内容暴露给中间人"
        );
        let endpoints = updater["endpoints"]
            .as_array()
            .expect("updater.endpoints 必须是数组");
        assert!(!endpoints.is_empty(), "没有端点就更新不了");
        for ep in endpoints {
            let url = ep.as_str().expect("endpoint 必须是字符串");
            assert!(url.starts_with("https://"), "更新端点必须走 https：{url}");
        }
    }

    #[test]
    fn capability_grants_stay_minimal() {
        let caps: serde_json::Value =
            serde_json::from_str(CAPABILITIES).expect("capabilities/default.json 不是合法 JSON");
        let perms = caps["permissions"]
            .as_array()
            .expect("permissions 必须是数组");
        // opener/fs/shell 之类的插件权限一旦给到前端，就绕开了后端命令里的路径与 scheme
        // 校验（例如 `open_external` 的白名单），所以只能经后端命令间接使用。
        const FORBIDDEN_PREFIXES: [&str; 5] = ["opener:", "fs:", "shell:", "http:", "dialog:"];
        for perm in perms {
            let name = perm
                .as_str()
                .or_else(|| perm["identifier"].as_str())
                .expect("权限项必须是字符串或带 identifier 的对象");
            for prefix in FORBIDDEN_PREFIXES {
                assert!(
                    !name.starts_with(prefix),
                    "capability 不该直接授予 `{prefix}` 权限（会绕过后端校验）：{name}"
                );
            }
        }
    }
}
