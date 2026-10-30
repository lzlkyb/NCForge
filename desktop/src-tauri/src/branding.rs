//! 应用名的单一来源（显示层）。
//!
//! 为何需要这个文件：把「给人看的名字」与「装在磁盘上的名字」分开，避免同一个应用
//! 两个名字——桌面通知标题、窗口标题用显示名；安装目录、exe 名、bundle identifier、
//! 防火墙规则名用标识层（`tauri.conf.json` 的 productName）。
//!
//! 改名时只改这里 + `tauri.conf.json` + `src/lib/about.ts` 三处（或跑
//! `node scripts/rename-app.mjs` 一把改完）。
//!
//! 前端那侧对应 `src/lib/about.ts` 的 `APP_INFO.name`，是同一个字符串的第二份维护
//! （前端拿不到 Rust 常量，只能各存一份）。改这里请同步改那边。
//!
//! 2026-10-31：托盘删除后，原来那三条 `tray_tip_*` 文案与它们的单测一并删掉了。

pub const APP_DISPLAY_NAME: &str = "NCForge";
