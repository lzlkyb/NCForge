import { invoke } from "./tauri";

/**
 * 应用配置（与 Rust `config::AppConfig` 一一对应）。
 *
 * **字段名是 Rust 的 snake_case，不是 camelCase**：`AppConfig` 没有
 * `#[serde(rename_all)]`，序列化出来就是 `release_webview_on_close`。
 * 以前这里用 `releaseWebviewOnClose` 读，读到的永远是 undefined —— 开关
 * 每次打开设置页都显示关闭；写回时又漏掉真正的字段，改了等于没改。
 * 新增字段时两边一起改，并且**写配置只用 `patchConfig` 提交要改的字段**（见下）。
 */
export interface AppConfig {
  release_webview_on_close: boolean;
  autostart_enabled: boolean;
  workspace_root: string | null;
  nc_home: string | null;
  /** 中间件堆上限（MB）；null = 默认 4G。改它走 `server_heap_set`，不要走 patchConfig。 */
  server_heap_mb: number | null;
}

/**
 * 可局部更新的设置项（Rust `commands::system::ConfigPatch`）。
 *
 * 只放「设置页自己拥有、且不需要额外校验」的字段。NC home / 工作区 / 堆上限各有专用
 * 命令（要探测目录、要在越界时明确报错），别往这里加。
 */
export interface ConfigPatch {
  release_webview_on_close?: boolean;
  autostart_enabled?: boolean;
}

export const getConfig = () => invoke<AppConfig>("get_config");

/**
 * 只提交要改的字段，返回改完的**完整配置**（可直接回填表单）。
 *
 * 为什么不是「整份 AppConfig 回写」：那要先 get、合并、再整份写，中间任何一次别的写入
 * 都会被覆盖；而且字段名写错一个字母时 serde 会忽略未知字段、回落成整份默认配置，
 * 把工作区 / NC home / 堆上限一起清空却返回成功。局部更新没有这两个失败模式。
 */
export const patchConfig = (patch: ConfigPatch) => invoke<AppConfig>("patch_config", { patch });
