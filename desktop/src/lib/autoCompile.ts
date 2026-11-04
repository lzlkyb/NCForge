import type { CompileResult } from "./compile";

/**
 * 保存后自动编译的纯逻辑：判断该不该编、结果怎么并回去。
 *
 * 没有副作用，全部可单测；定时与串行在 `autoCompileQueue.ts`，执行在后端
 * （`commands::compile_file`）。三件事分开是因为它们的失败方式完全不同：
 * 判据错=白跑一次 JVM，合并错=问题面板显示的不是真的，队列错=保存后没反应。
 */

/** ecj 只认 `.java`：保存 xml / properties / js 时不该触发编译。 */
export const isJavaFile = (path: string) => path.toLowerCase().endsWith(".java");

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * 该不该为这个刚保存的文件触发自动编译。
 *
 * `root` 是工作区根（`getSession().root`）。关联工程的文件在**工作区之外**，
 * 后端 `resolve_module` 会直接拒绝——它们有自己的 `.classpath`，得切过去才编得了。
 * 在发 IPC 之前挡掉，免得每保存一次就弹一次「所选路径不在工作区的某个模块里」。
 */
export function isAutoCompileTarget(path: string, root: string | null | undefined): boolean {
  if (!path || !root || !isJavaFile(path)) return false;
  // `jdt://` 之类的虚拟路径没有磁盘文件
  if (path.includes("://")) return false;
  const r = norm(root);
  const f = path.replace(/\\/g, "/").toLowerCase();
  return f.startsWith(`${r}/`);
}

/** 诊断行的身份：同一条推断只留一份（并集里 prev/next 会重叠）。 */
const diagKey = (d: CompileResult["diagnostics"][number]) =>
  `${d.kind}|${d.project}|${d.file ?? ""}`;

/**
 * 把「编译这几个文件」的结果并回上一次的完整结果。
 *
 * **只替换这几个文件自己的问题**，其它文件的历史问题必须留着——否则保存一次就把
 * 上一轮整模块编译报的二十条错误全清掉，用户会以为都修好了。
 *
 * 一批可能跨模块（连续保存了几个目录下的文件），所以 `files` 是集合而不是单个路径。
 *
 * `prev` 为空（还没编译过）时直接采用 `next`：此时并回去没有意义，
 * 而且 `next` 里已经有这几个文件的全部问题。
 */
export function mergeFileResult(
  prev: CompileResult | null,
  next: CompileResult,
  files: readonly string[],
): CompileResult {
  if (!prev) return next;
  const targets = new Set(files.map(norm));
  const problems = [...prev.problems.filter((p) => !targets.has(norm(p.file))), ...next.problems];
  const errorCount = problems.filter((p) => p.severity === "error").length;

  // 诊断按身份并集去重：D4 那几条（有源码没产物 / 工程停用）是整图推断，
  // 单文件编译只覆盖自己这一小块，直接丢掉 prev 的会让人以为状态好转了。
  // `next` 排前面：同一条推断有新旧两版时，取这次算出来的。
  const seen = new Set<string>();
  const diagnostics = [...next.diagnostics, ...prev.diagnostics].filter((d) => {
    const k = diagKey(d);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    ...next,
    problems,
    errorCount,
    warningCount: problems.length - errorCount,
    ok: errorCount === 0,
    diagnostics,
  };
}
