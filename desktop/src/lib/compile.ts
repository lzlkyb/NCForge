import { invoke, listen } from "./tauri";

// 与 Rust `compile.rs` 的 serde 结构对应（camelCase）。
export interface Problem {
  severity: "error" | "warning";
  file: string;
  line: number;
  message: string;
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
}

/** 编译 `path` 所在的模块（模块目录或模块内任一文件）。 */
export const compileModule = (path: string) => invoke<CompileResult>("compile_module", { path });

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
