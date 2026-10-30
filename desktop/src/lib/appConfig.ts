import { invoke } from "./tauri";

/**
 * 应用配置（与 Rust `config::AppConfig` 一一对应）。
 *
 * **字段名是 Rust 的 snake_case，不是 camelCase**：`AppConfig` 没有
 * `#[serde(rename_all)]`，序列化出来就是 `autostart_enabled`。
 * 以前这里用 camelCase 读，读到的永远是 undefined —— 开关每次打开设置页都显示
 * 关闭；写回时又漏掉真正的字段，改了等于没改。
 * 新增字段时两边一起改，并且**写配置只用 `patchConfig` 提交要改的字段**（见下）。
 */
export interface AppConfig {
  autostart_enabled: boolean;
  workspace_root: string | null;
  nc_home: string | null;
  /** 中间件堆上限（MB）；null = 默认 4G。改它走 `server_heap_set`，不要走 patchConfig。 */
  server_heap_mb: number | null;
  /** 代码智能总开关 / 打开新模块时自动启动 / jdt.ls 内存上限（MB，null = 默认 1024）。改它们走 `langConfigSet`。 */
  lang_enabled: boolean;
  lang_auto_start: boolean;
  lang_xmx_mb: number | null;
}

/** 代码智能设置的局部更新。`lang_xmx_mb: 0` = 恢复默认；越界（512~4096 之外）后端会明确报错。 */
export interface LangConfigPatch {
  lang_enabled?: boolean;
  lang_auto_start?: boolean;
  lang_xmx_mb?: number;
}

export const langConfigSet = (patch: LangConfigPatch) =>
  invoke<AppConfig>("lang_config_set", { patch });

/** 重新生成影子工程（停掉 → 清缓存 → 重新拉起当前模块）。 */
export const langRegenerate = () => invoke<unknown>("lang_regenerate");

/**
 * 可局部更新的设置项（Rust `commands::system::ConfigPatch`）。
 *
 * 只放「设置页自己拥有、且不需要额外校验」的字段。NC home / 工作区 / 堆上限各有专用
 * 命令（要探测目录、要在越界时明确报错），别往这里加。
 */
export interface ConfigPatch {
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
