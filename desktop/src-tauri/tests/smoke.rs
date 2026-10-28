//! 集成测试占位 + 链接冒烟。
//!
//! 存在意义：cargo 要求包内**有 test 目标**才接受 build.rs 发出的
//! `cargo:rustc-link-arg-tests` 指令（否则报 "package does not have a
//! test target"）。该指令给 Windows 测试二进制补嵌 comctl32 v6 manifest，
//! 是 mock 应用集成测试能启动的前提——根因详见 build.rs 长注释。
//!
//! 本文件同时验证 lib 公开 API 可被测试目标正常引用。

#[test]
fn public_api_is_linkable() {
    // branding 是纯 Rust 显示名单，零原生依赖，适合做链接冒烟。
    assert!(!nc_forge::branding::APP_DISPLAY_NAME.is_empty());
}
