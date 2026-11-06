import type { CompileResult } from "./compile";
import { mergeCompileSnapshots } from "./compileFreshness";

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

  // 模块账本也要按模块合并：单文件编译只带自己那个模块的一条，
  // 直接 `...next` 会把前不久全量构建留下的其它模块账本整份抹掉。
  const modules = mergeModuleLedger(prev.modules, next.modules);

  return {
    ...next,
    problems,
    ...mergeCompileSnapshots(prev, next, path => targets.has(norm(path))),
    errorCount,
    warningCount: problems.length - errorCount,
    ok: errorCount === 0,
    diagnostics,
    ...(modules ? { modules } : {}),
  };
}

/** 按模块名替换账本；`next` 没有账本时保留 `prev`（老后端 / 测试桩）。 */
function mergeModuleLedger(
  prev: CompileResult["modules"],
  next: CompileResult["modules"],
): CompileResult["modules"] {
  if (!next || next.length === 0) return prev;
  if (!prev || prev.length === 0) return next;
  const touched = new Set(next.map((m) => m.module));
  return [...prev.filter((m) => !touched.has(m.module)), ...next];
}

/**
 * 把一次**模块级增量**的结果并回上一次的完整结果。
 *
 * 与 `mergeFileResult` 的差别：增量的影响面是「受影响的 module 目录」，
 * 不是「刚保存的那几个文件」——改了方法签名时，引用方模块也会被重编，
 * 它们的问题必须一起替换，否则问题面板会同时留着新旧两版错误。
 *
 * `prev` 为空时直接用 `next`（第一次编译，没有可保留的东西）。
 */
export function mergeModuleResult(
  prev: CompileResult | null,
  next: CompileResult,
  root: string,
): CompileResult {
  const modules = next.modules ?? [];
  if (!prev) return next;
  if (modules.length === 0) return mergeFileResult(prev, next, []);

  // 只有真正重编过的模块才能替换旧问题。`skipped`（没有源码变化）和
  // `blocked`（依赖失败，没轮到它）都没有产生新信息：把旧问题留着，
  // 否则一次「跳过」会把上一轮失败的错误从问题面板里抹掉。
  const rebuilt = new Set(
    modules
      .filter((m) => m.status !== "skipped" && m.status !== "blocked")
      .map((m) => m.module.toLowerCase()),
  );
  const prefixes = [...rebuilt].map((m) => `${norm(root)}/${m}/`);
  const inAffected = (file: string) => {
    const f = norm(file);
    return prefixes.some((p) => f.startsWith(p));
  };

  const problems = [
    ...prev.problems.filter((p) => !inAffected(p.file)),
    ...next.problems,
  ];
  const errorCount = problems.filter((p) => p.severity === "error").length;

  // `next` 是这次重编模块的新推断；`prev` 里只补未参与本轮推断的模块。
  // 注意不能因为项目在 `rebuilt` 里就把 `next` 自己的诊断也筛掉——那样重编完
  // 反而看不到当前状态。
  const diagnostics = [...next.diagnostics];
  const seen = new Set(diagnostics.map(diagKey));
  for (const d of prev.diagnostics) {
    if (rebuilt.has(d.project.toLowerCase())) continue;
    const k = diagKey(d);
    if (seen.has(k)) continue;
    seen.add(k);
    diagnostics.push(d);
  }

  return {
    ...next,
    // 未受影响模块的计数还在 prev 里：把它们的错误/警告补回来
    ...mergeCompileSnapshots(prev, next, inAffected),
    problems,
    errorCount,
    warningCount: problems.length - errorCount,
    ok: errorCount === 0,
    diagnostics,
    modules: mergeModuleLedger(prev.modules, next.modules),
    jarCount: Math.max(prev.jarCount, next.jarCount),
  };
}
