import { invoke } from "./tauri";
import { inputLines, type JavaRunConfig } from "./javaRunConfig";

/**
 * 启动配置库（`<工程根>/.ncforge/launches.json`）的前端侧。
 *
 * 三类目标与后端 `launch_config.rs` 的数据模型一一对应（内部标签 `kind`）：
 * middleware / client / java。**每个可选项都是「写了才覆盖」**——没写的项跟随
 * 全局配置，所以「不选任何配置」就是本工具此前一贯的行为。
 *
 * 这里只做「存取 + 派生」：真正起进程的是 server/client/javaRun 三条 IPC，
 * 启动配置把覆盖值递给它们（仅本次生效，不写回全局配置）。
 */

export type LaunchKind = "middleware" | "client" | "java";

export interface MiddlewareOptions {
  /** null = 跟随全局配置。 */
  heapMb: number | null;
  /** null = 默认名单（与 Eclipse 一致的 5 个）。 */
  hotwebs: string[] | null;
  debug: boolean;
}
export interface ClientOptions {
  heapMb: number | null;
  debug: boolean;
}
export interface JavaOptions {
  path: string;
  mode: "main" | "test";
  classes: string[];
  args: string[];
  extraClasspath: string[];
  debug: boolean;
  coverage: boolean;
}

export type LaunchTarget =
  | ({ kind: "middleware" } & MiddlewareOptions)
  | ({ kind: "client" } & ClientOptions)
  | ({ kind: "java" } & JavaOptions);

export interface LaunchConfig {
  /** 空串 = 新建（保存时后端分配）。 */
  id: string;
  name: string;
  target: LaunchTarget;
}

export interface LaunchConfigList {
  configs: LaunchConfig[];
  /** 读取时跳过/降级的条目说明；为空表示一切正常。 */
  notes: string[];
  /**
   * `save` / `duplicate` 入库后的那条 id；`list` / `delete` 恒为 null。
   *
   * 有它就够，不用再拿前后列表做差集——缓存还没预热时旧列表是空的，
   * 差集会把列表里第一条老配置当成「新建的」。
   */
  savedId: string | null;
}

/** 递给启动命令的覆盖值。缺省/undefined = 用全局配置。 */
export interface MiddlewareOverrides {
  heapMb?: number | null;
  hotwebs?: string[] | null;
}
export interface ClientOverrides {
  heapMb?: number | null;
}

export const listLaunchConfigs = () => invoke<LaunchConfigList>("launch_config_list");
export const saveLaunchConfig = (config: LaunchConfig) => invoke<LaunchConfigList>("launch_config_save", { config });
export const deleteLaunchConfig = (id: string) => invoke<LaunchConfigList>("launch_config_delete", { id });
export const duplicateLaunchConfig = (id: string) => invoke<LaunchConfigList>("launch_config_duplicate", { id });

export const LAUNCH_KIND_LABELS: Record<LaunchKind, string> = { middleware: "中间件", client: "客户端", java: "Java 运行" };

export const launchConfigsOf = (list: LaunchConfigList | undefined, kind: LaunchKind): LaunchConfig[] =>
  (list?.configs ?? []).filter(config => config.target.kind === kind);

/** 下拉框里的一行摘要：让人不点开就知道这条配置会怎么起。 */
export function launchSummary(config: LaunchConfig): string {
  const t = config.target;
  if (t.kind === "middleware") {
    const parts = [t.heapMb ? `${Math.round(t.heapMb / 1024)}G` : "堆随全局"];
    parts.push(t.hotwebs ? `${t.hotwebs.length} 个 web 应用` : "web 应用随全局");
    if (t.debug) parts.push("调试");
    return parts.join(" · ");
  }
  if (t.kind === "client") return [t.heapMb ? `${Math.round(t.heapMb / 1024)}G` : "堆随全局", t.debug ? "调试" : "无调试"].join(" · ");
  const count = t.classes.length;
  return `${t.mode === "test" ? "JUnit" : "main"} · ${count} 个目标${t.debug ? " · 调试" : ""}${t.coverage ? " · 覆盖率" : ""}`;
}

/** 「保存为配置」用的空模板（id 留空，后端分配）。 */
export function emptyLaunchConfig(kind: LaunchKind, name: string): LaunchConfig {
  const target: LaunchTarget =
    kind === "middleware" ? { kind: "middleware", heapMb: null, hotwebs: null, debug: false }
      : kind === "client" ? { kind: "client", heapMb: null, debug: false }
        : { kind: "java", path: "", mode: "main", classes: [], args: [], extraClasspath: [], debug: false, coverage: false };
  return { id: "", name, target };
}

/** 选中的中间件配置 → 启动覆盖值。null = 「默认」（不覆盖）。 */
export function middlewareOverridesOf(config: LaunchConfig | null): MiddlewareOverrides | undefined {
  if (!config || config.target.kind !== "middleware") return undefined;
  const t = config.target;
  return { heapMb: t.heapMb, hotwebs: t.hotwebs };
}

export function clientOverridesOf(config: LaunchConfig | null): ClientOverrides | undefined {
  if (!config || config.target.kind !== "client") return undefined;
  return { heapMb: config.target.heapMb };
}

/** Java 运行配置 ↔ 运行面板的文本态配置。 */
export function javaOptionsToRunConfig(t: Extract<LaunchTarget, { kind: "java" }>): JavaRunConfig {
  return { path: t.path, mode: t.mode, classes: t.classes.join("\n"), args: t.args.join("\n"), extraClasspath: t.extraClasspath.join("\n") };
}

export function runConfigToJavaOptions(config: JavaRunConfig, debug: boolean, coverage: boolean): Extract<LaunchTarget, { kind: "java" }> {
  return {
    kind: "java",
    path: config.path.trim(),
    mode: config.mode,
    classes: inputLines(config.classes).map(line => line.trim()),
    args: inputLines(config.args).map(line => line.trim()),
    extraClasspath: inputLines(config.extraClasspath).map(line => line.trim()),
    debug,
    coverage,
  };
}
