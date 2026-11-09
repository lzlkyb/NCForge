import { invoke } from "./tauri";
import { trackOperation } from "./operations";
import type { LinkedOverride } from "./linkedProjects";

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
  /**
   * 启动时挂载的 web 应用（`hotwebs/` 目录名）；null = 默认名单（与 Eclipse 一致）。
   * 改它走 `hotwebs_set`（要校验目录存在），不要走 patchConfig。
   */
  hotwebs: string[] | null;
  /** 代码智能总开关 / 打开新模块时自动启动 / jdt.ls 内存上限（MB，null = 默认 1024）。改它们走 `langConfigSet`。 */
  lang_enabled: boolean;
  lang_auto_start: boolean;
  lang_xmx_mb: number | null;
  /**
   * 多工程覆盖表（停用 / 排前 / 追加目录）。
   *
   * 字段名同样是 snake_case；**条目内**是 `action/target/dir` 几个单词，两边写法一致。
   * 改它走 `setLinkedOverrides`（整表替换），不要用 `patchConfig`——`ConfigPatch`
   * 只放设置页自己拥有的单值字段，整表进来的话一次误传就把用户手写的覆盖清空了。
   */
  linked_overrides: LinkedOverride[];
  /** 编译/启动前自动把工程 `META-INF` 元数据投送到 NCHOME（默认开）。 */
  deploy_on_start: boolean;
  /** 启动中间件时挂上热替换 agent（默认开，下次启动生效）。界面开关在设置 → 任务 → 热替换。 */
  hotswap_enabled: boolean;
  /** 编译成功后自动推送热替换（默认开）；关闭时只攒待推列表。 */
  hotswap_auto: boolean;
  /** 保存 `.java` 后自动编译该文件（默认开）。只编这一个文件，不编整模块。 */
  auto_compile: boolean;
  /** 单文件编译后空闲一段时间，再跑一次模块级增量（补上签名变更的引用方，默认开）。 */
  auto_compile_incremental: boolean;
  /** 工作区外的 `.java` 被其他程序改动时也自动编译（默认开）。 */
  auto_compile_external: boolean;
  /** 打开工作区时后台预热类索引（默认开）。 */
  prewarm_index: boolean;
  /** 复用常驻 ecj JVM（默认开）。关掉 = 每次编译单独起进程，慢但内存最低。 */
  persistent_worker: boolean;
  /** 独立模块并行构建的上限（1 = 串行，默认 2，后端夹在 1~4）。 */
  build_parallel: number;
}

/** 代码智能设置的局部更新。`lang_xmx_mb: 0` = 恢复默认；越界（512~4096 之外）后端会明确报错。 */
export interface LangConfigPatch {
  lang_enabled?: boolean;
  lang_auto_start?: boolean;
  lang_xmx_mb?: number;
}

export const langConfigSet = (patch: LangConfigPatch) =>
  trackOperation({ key: "settings.lang", label: "保存代码智能设置", page: "settings" }, () => invoke<AppConfig>("lang_config_set", { patch }));

/** 重新生成影子工程（停掉 → 清缓存 → 重新拉起当前模块）。 */
export const langRegenerate = () => trackOperation({ key: "lang.regenerate", label: "重新生成影子工程", page: "files", phase: "停止服务、清理缓存并重新生成" }, () => invoke<unknown>("lang_regenerate"), () => ({ state: "success", detail: "工程已重新生成；代码智能索引继续准备" }));

/**
 * 可局部更新的设置项（Rust `commands::system::ConfigPatch`）。
 *
 * 只放「设置页自己拥有、且不需要额外校验」的字段。NC home / 工作区 / 堆上限各有专用
 * 命令（要探测目录、要在越界时明确报错），别往这里加。
 */
export interface ConfigPatch {
  autostart_enabled?: boolean;
  deploy_on_start?: boolean;
  auto_compile?: boolean;
  auto_compile_incremental?: boolean;
  auto_compile_external?: boolean;
  prewarm_index?: boolean;
  persistent_worker?: boolean;
  build_parallel?: number;
  hotswap_enabled?: boolean;
  hotswap_auto?: boolean;
}

export const getConfig = () => invoke<AppConfig>("get_config");

/**
 * 自动编译几个开关的进程内缓存。
 *
 * 保存是高频动作，每次 Ctrl+S 都发一次 `get_config` 不值得；这些开关只在设置页
 * 变（那里写完会调 `remember*`），所以缓存一份就够。三个开关共用一次 `get_config`，
 * 避免首轮保存连发三次 IPC。
 * 读不到配置时按默认（开）走——真正的兜底在 `compile_file` 那侧，多编一次不会坏事。
 */
interface BuildFlags {
  autoCompile: boolean;
  autoIncremental: boolean;
  autoExternal: boolean;
}

const DEFAULT_FLAGS: BuildFlags = {
  autoCompile: true,
  autoIncremental: true,
  autoExternal: true,
};
let flags: BuildFlags | null = null;
let flagsPromise: Promise<BuildFlags> | null = null;

function flagsFrom(c: AppConfig): BuildFlags {
  return {
    autoCompile: c.auto_compile ?? true,
    autoIncremental: c.auto_compile_incremental ?? true,
    autoExternal: c.auto_compile_external ?? true,
  };
}

async function loadFlags(): Promise<BuildFlags> {
  if (flags) return flags;
  if (!flagsPromise) {
    flagsPromise = getConfig()
      .then((c) => (flags = flagsFrom(c)))
      .catch(() => (flags = { ...DEFAULT_FLAGS }));
  }
  return flagsPromise;
}

export async function isAutoCompileEnabled(): Promise<boolean> {
  return (await loadFlags()).autoCompile;
}

/** 单文件编译后是否要再跑模块级增量。 */
export const isAutoIncrementalEnabled = async () => (await loadFlags()).autoIncremental;

/** 工作区外的 `.java` 改动是否也要触发自动编译。 */
export const isAutoExternalEnabled = async () => (await loadFlags()).autoExternal;

/** 同步读开关缓存；还没读过配置时按默认（开）处理，与 `isAutoCompileEnabled` 一致。
 *
 * 给「保存成功要不要弹提示」这种同步路径用：那里不能为了一个 UI 决定去 await
 * 一次 IPC，而开关本来就有缓存。
 */
export function autoCompileCached(): boolean {
  return flags?.autoCompile ?? true;
}

/** 文件监听回调里不能 await：外部改动是否编译用同步缓存判断。 */
export function autoExternalCached(): boolean {
  return flags?.autoExternal ?? true;
}

function remember(patch: Partial<BuildFlags>) {
  flags = { ...(flags ?? DEFAULT_FLAGS), ...patch };
}

/** 设置页改完开关时同步缓存（否则要重启才生效）。 */
export function rememberAutoCompile(on: boolean) {
  remember({ autoCompile: on });
}

export function rememberAutoIncremental(on: boolean) {
  remember({ autoIncremental: on });
}

export function rememberAutoExternal(on: boolean) {
  remember({ autoExternal: on });
}

/**
 * 只提交要改的字段，返回改完的**完整配置**（可直接回填表单）。
 *
 * 为什么不是「整份 AppConfig 回写」：那要先 get、合并、再整份写，中间任何一次别的写入
 * 都会被覆盖；而且字段名写错一个字母时 serde 会忽略未知字段、回落成整份默认配置，
 * 把工作区 / NC home / 堆上限一起清空却返回成功。局部更新没有这两个失败模式。
 */
export const patchConfig = (patch: ConfigPatch) => trackOperation({ key: "settings.config", label: "保存工作台设置", page: "settings" }, () => invoke<AppConfig>("patch_config", { patch }));
