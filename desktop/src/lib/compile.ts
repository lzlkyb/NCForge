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

/**
 * 一个模块在一轮构建里的结果（后端 `ModuleBuildResult`）。
 *
 * 与合并后的 `CompileResult` 分开：错误总数会把多个模块加在一起，而用户要问的
 * 恰恰是「哪个模块没过、为什么被跳过」。账本保留每个模块自己的状态。
 */
export interface ModuleBuildResult {
  module: string;
  /** `ok` / `failed` / `blocked` / `skipped` / `cleaned` */
  status: "ok" | "failed" | "blocked" | "skipped" | "cleaned";
  errorCount: number;
  warningCount: number;
  durationMs: number;
  sourceCount: number;
  outDir: string;
  /** 本轮清理掉的 class 数（清理并重编时） */
  cleaned: number;
  /** 跳过 / 阻断的原因（给用户看的一句话） */
  reason: string | null;
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
  /**
   * 按模块的结果账本。老后端不返回这个字段，所以类型上可选；
   * 读取处统一 `?? []`，不要假设它一定存在。
   */
  modules?: ModuleBuildResult[];
  /** Frontend receipt time and the open files' disk versions captured before compilation. */
  completedAtMs?: number;
  sourceSnapshots?: Record<string, { mtimeMs: number; atMs: number }>;
}

/** 一轮构建的进度（后端 `build-progress` 事件）。 */
export interface BuildProgress {
  /** 当前阶段（中文，例如「解析模块」「编译」） */
  phase: string;
  done: number;
  total: number;
  /** 正在编的模块；阶段级进度为 null */
  module: string | null;
  elapsedMs: number;
}

/** 清理一个模块的产物报告（`build_clean_module` / `build_clean_all`）。 */
export interface CleanReport {
  module: string;
  outputs: string[];
  removed: number;
  files: string[];
  failed: string[];
  unknown: string[];
  unknownCount: number;
  dirsRemoved: number;
  hadManifest: boolean;
  svnDetected: boolean;
  manifestRemoved: boolean;
  notes: string[];
}

/** 构建历史的一条记录。 */
export interface BuildHistoryEntry {
  atMs: number;
  module: string;
  status: string;
  errorCount: number;
  warningCount: number;
  durationMs: number;
  reason: string;
}

/** 常驻 worker 的累计计数（进程内，重启清零）。 */
export interface WorkerStats {
  coldStarts: number;
  warmHits: number;
  fallbackMissing: number;
  fallbackSpawn: number;
  fallbackProtocol: number;
  fallbackOom: number;
  timeouts: number;
  cancels: number;
  trimmed: number;
  workerCompiles: number;
  workerMsTotal: number;
  oneshotCompiles: number;
  oneshotMsTotal: number;
  /** 耗时桶：<100ms、<300ms、<1s、<3s、≥3s */
  latency: number[];
}

/** 设置页「维护」卡片用的缓存统计。 */
export interface BuildCacheInfo {
  indexBytes: number;
  indexFiles: number;
  manifestBytes: number;
  manifestModules: number;
  tmpBytes: number;
  trackedClasses: number;
  /** 产物目录里存在、但清单里没有对应源文件的 class（最多 100 条） */
  untrackedClasses: string[];
  lastSuccessMs: number | null;
  lastBuild: BuildHistoryEntry | null;
  history: BuildHistoryEntry[];
  parallel: number;
  worker: WorkerStats;
}

export interface CleanTmpReport {
  removed: number;
  bytes: number;
}

/** 编译 `path` 所在的模块（模块目录或模块内任一文件）。 */
export const compileModule = (path: string) => invoke<CompileResult>("compile_module", { path });

/**
 * `compile_file` 的结果。
 *
 * 跳过有四种原因，必须分开：`index-cold`（类索引还没建好，提示一次就行）、
 * `busy`（有编译在跑，等它结束要重排）、`no-module` / `not-java`（没什么可编的，
 * 静默）。用一个 `null` 表达全部时，前端只能猜，于是把「跳过」说成
 * 「已有一次编译在进行」——那种误导文案比不提示更糟。
 */
export type CompileFileOutcome =
  | { status: "done"; result: CompileResult }
  | { status: "skipped"; code: "index-cold" | "busy" | "no-module"; message: string };

/**
 * 编译一批文件（保存后自动编译 / 手动「编译当前文件」共用）。
 *
 * 后端按模块分组、每组一轮 JVM：一批 5 个同模块文件只起 1 次 ecj，而不是 5 次。
 */
export const compileFile = (paths: string[]) =>
  invoke<CompileFileOutcome>("compile_file", { paths });

/** 手动入口用：跳过不是结果，转成一句能直接给用户看的错误。 */
export async function compileFileOrThrow(paths: string[]): Promise<CompileResult> {
  const o = await compileFile(paths);
  if (o.status === "done") return o.result;
  throw new Error(o.message);
}

/**
 * 按依赖顺序编译工作区里的全部模块（被依赖的先编，编不过就停）。
 *
 * 与 `compileModule` 分开两条命令而不是加参数：多模块那轮**不是单模块的超集**——
 * 它会在第一个失败的模块处停下，所以结果里的 `outDir` 是一句汇总而不是某个目录。
 */
export const compileAllModules = (forceFull?: boolean, skipDeploy?: boolean) =>
  invoke<CompileResult>("compile_all_modules", { forceFull, skipDeploy });

/**
 * 模块级增量编译：只重编受影响的模块，交给后端判断哪些文件真的变了。
 *
 * 与 `compileFile` 的两阶段配合：保存时先单文件快速反馈，空闲 2.5 秒后再调这里
 * 补上「签名变了、引用方也得重编」这一层。结果是**模块账本**，合并时按模块替换。
 */
export const compileIncremental = (paths: string[]) =>
  invoke<CompileResult>("compile_incremental", { paths });

/** 清理一个模块的产物。`dryRun=true` 只统计不删除，给确认框用。 */
export const buildCleanModule = (path: string, dryRun?: boolean) =>
  invoke<CleanReport>("build_clean_module", { path, dryRun });

/** 清理工作区全部模块的产物。`dryRun=true` 只统计不删除。 */
export const buildCleanAll = (dryRun?: boolean) =>
  invoke<CleanReport[]>("build_clean_all", { dryRun });

/** 清理并重编一个模块（先删产物，再全量编）。 */
export const buildRebuildModule = (path: string) =>
  invoke<CompileResult>("build_rebuild_module", { path });

/** 清理并重编全部模块。 */
export const buildRebuildAll = () => invoke<CompileResult>("build_rebuild_all");

/** 重建类索引（删索引文件与构建清单，不删产物）。 */
export const buildReindex = () => invoke<string>("build_reindex");

/** 清理编译临时文件（参数文件 / 原子写残留），不碰工作区。 */
export const buildCleanTmp = () => invoke<CleanTmpReport>("build_clean_tmp");

/** 构建缓存统计（索引 / 清单 / 临时文件 / 未跟踪产物 / 历史）。 */
export const buildCacheInfo = () => invoke<BuildCacheInfo>("build_cache_info");

/** 构建历史（最近 50 条模块结果）。 */
export const buildHistory = () => invoke<BuildHistoryEntry[]>("build_history");

/** 订阅一轮构建的进度（模块粒度），返回取消订阅函数。 */
export const onBuildProgress = (handler: (p: BuildProgress) => void) =>
  listen<BuildProgress>("build-progress", handler);

/**
 * 取消正在跑的编译。后端只置一个标志，ecj 子进程会在 40ms 内被杀掉。
 * 取消后 `compileModule` 以 `CANCELLED:` 前缀的错误返回。
 */
export const compileCancel = () => invoke<void>("compile_cancel");

/** 这次失败是不是「用户自己点的取消」。 */
export const isCompileCancelled = (e: unknown) => String(e instanceof Error ? e.message : e).startsWith("CANCELLED:");

/** 订阅编译过程中的逐行进度，返回取消订阅函数。 */
export const onCompileLog = (handler: (line: string) => void) => listen<string>("compile-log", handler);

/** 结果里的绝对路径换成相对工作区的显示名（找不到前缀就原样返回）。 */
export function relativeTo(root: string, file: string): string {
  const r = root.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const f = file.replace(/\\/g, "/");
  return f.toLowerCase().startsWith(`${r}/`) ? f.slice(r.length + 1) : f;
}
