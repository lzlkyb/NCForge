import { invoke, listen } from "./tauri";

// 与 Rust `compile.rs` 的 serde 结构对应（camelCase）。
export interface Problem {
  severity: "error" | "warning";
  file: string;
  line: number;
  message: string;
}

/**
 * 编译诊断（D4）：ecj 原文之外的**我们的推断**，不算错误数。
 *
 * - `uncompiled`：关联工程里有这个类的源码，但没有编译产物
 * - `disabled`：源码所在工程被覆盖表停用了
 * - `stale-class`：类在，但产物比源码旧（编译静默通过、用的是改动前的版本）
 * - `stale`：整个工程的产物比源码旧（**按需**检查才有，见 `checkArtifacts`）
 * - `no-output`：整个工程一个 class 产物都没有（同上）
 */
export interface CompileDiagnostic {
  kind: "uncompiled" | "disabled" | "stale-class" | "stale" | "no-output";
  project: string;
  message: string;
  /** 相关源码路径（可点开），工程级诊断没有 */
  file: string | null;
}

export interface CompileResult {
  ok: boolean;
  durationMs: number;
  sourceCount: number;
  errorCount: number;
  warningCount: number;
  problems: Problem[];
  jarCount: number;
  rounds: number;
  outDir: string;
  /** D4 诊断：产物比源码旧 / 有源码没产物 / 工程被停用 */
  diagnostics: CompileDiagnostic[];
}

/** 编译 `path` 所在的模块（模块目录或模块内任一文件）。 */
export const compileModule = (path: string) => invoke<CompileResult>("compile_module", { path });

/**
 * 按依赖顺序编译工作区里的全部模块（被依赖的先编，编不过就停）。
 *
 * 与 `compileModule` 分开两条命令而不是加参数：多模块那轮**不是单模块的超集**——
 * 它会在第一个失败的模块处停下，所以结果里的 `outDir` 是一句汇总而不是某个目录。
 */
export const compileAllModules = () => invoke<CompileResult>("compile_all_modules");

/**
 * 取消正在跑的编译。后端只置一个标志，ecj 子进程会在 40ms 内被杀掉。
 * 取消后 `compileModule` 以 `CANCELLED:` 前缀的错误返回。
 */
export const compileCancel = () => invoke<void>("compile_cancel");

/** 这次失败是不是「用户自己点的取消」。 */
export const isCompileCancelled = (e: unknown) => String(e).startsWith("CANCELLED:");

/** 订阅编译过程中的逐行进度，返回取消订阅函数。 */
export const onCompileLog = (handler: (line: string) => void) => listen<string>("compile-log", handler);

/** 结果里的绝对路径换成相对工作区的显示名（找不到前缀就原样返回）。 */
export function relativeTo(root: string, file: string): string {
  const r = root.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const f = file.replace(/\\/g, "/");
  return f.toLowerCase().startsWith(`${r}/`) ? f.slice(r.length + 1) : f;
}
