//! 应用名的单一来源（显示层）。
//!
//! 为何需要这个文件：把「给人看的名字」与「装在磁盘上的名字」分开，避免同一个应用
//! 两个名字——托盘 tooltip、桌面通知标题、窗口标题用显示名；安装目录、exe 名、
//! bundle identifier、防火墙规则名用标识层（`tauri.conf.json` 的 productName）。
//!
//! 改名时只改这里 + `tauri.conf.json` + `src/lib/about.ts` 三处（或跑
//! `node scripts/rename-app.mjs` 一把改完）。
//!
//! 前端那侧对应 `src/lib/about.ts` 的 `APP_INFO.name`，是同一个字符串的第二份维护
//! （前端拿不到 Rust 常量，只能各存一份）。改这里请同步改那边。

pub const APP_DISPLAY_NAME: &str = "NCForge";

/// 托盘 tooltip 的三条文案，用 `format!` 在**运行时**拼进 `APP_DISPLAY_NAME`。
///
/// 为何不是 `concat!` 编译期拼接：Rust 的 `concat!` 只接受字面量，const 路径
/// 会被拒（"expected a literal"）。要编译期拼接就得把显示名手抄进每条文案——
/// 改名后托盘停留在旧名字，而那是纯运行时可见的（编译器不提醒、测试不覆盖），
/// 用户看到的就是"装的是新名字、托盘还叫旧名字"。这三条只在托盘刷新时调用
/// 一次，`format!` 的一次堆分配无所谓，换来的是单一真相源。
pub fn tray_tip_running() -> String {
    format!("{APP_DISPLAY_NAME} · 运行中")
}

pub fn tray_tip_stopped() -> String {
    format!("{APP_DISPLAY_NAME} · 已停止")
}

pub fn tray_tip_ip_changed() -> String {
    format!("{APP_DISPLAY_NAME}: 网络地址已变化，点击查看")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_tips_embed_display_name() {
        // 单一真相源的机器保证：三条文案都必须以显示名开头。手抄显示名会在这里现形——
        // rename-app.mjs 改 APP_DISPLAY_NAME 后，托盘文案若停留在旧名字，此测试必红。
        for tip in [
            tray_tip_running(),
            tray_tip_stopped(),
            tray_tip_ip_changed(),
        ] {
            assert!(
                tip.starts_with(APP_DISPLAY_NAME),
                "托盘文案应以显示名开头：{tip}"
            );
            assert!(
                tip.len() > APP_DISPLAY_NAME.len(),
                "文案只剩显示名、没有状态后缀：{tip}"
            );
        }
    }

    #[test]
    fn tray_tips_are_distinct() {
        let tips = [
            tray_tip_running(),
            tray_tip_stopped(),
            tray_tip_ip_changed(),
        ];
        assert_ne!(tips[0], tips[1]);
        assert_ne!(tips[1], tips[2]);
        assert_ne!(tips[0], tips[2]);
    }
}
