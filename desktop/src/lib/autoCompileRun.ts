/**
 * 「保存后自动编译」的执行侧：一**批**文件 → 一次 IPC → 并回结果。
 *
 * 从 `useModuleCompile` 里抽出来，因为它不依赖任何 React 状态（读写的都是
 * `workspaceSession` 的模块级仓库）。留在 hook 里有两个坏处：那个 hook 已经顶到
 * 组件体量门禁，而且批处理逻辑和「谁注册队列」混在一起，单测只能靠渲染。
 *
 * 与手动编译（`useModuleCompile.start`）刻意不同的四件事：不清编译日志
 * （那是手动编译的输出面板）、不切面板 tab、不打开底部面板、不投送元数据。
 * 保存是高频动作，任何「顺手把界面推到某处」的副作用都会变成骚扰。
 */
import { baseName } from "./workspace";
import { getSession, setSession } from "./workspaceSession";
import { isAutoCompileEnabled } from "./appConfig";
import { compileFile, isCompileCancelled } from "./compile";
import { isAutoCompileTarget, mergeFileResult } from "./autoCompile";
import { requeueAutoCompile } from "./autoCompileQueue";
import { toast } from "../components/ui/toast";

const sameFile = (a: string, b: string) =>
  a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

/** 「索引还没建好」是全局状态，不是某个文件的问题：只提示一次，别每次保存都弹。 */
let hintedColdIndex = false;

/** 该文件此前已有的错误条数（用来判断「这次是不是新出的错」）。 */
function errorCountOf(problems: { severity: string; file: string }[], files: readonly string[]) {
  return problems.filter(
    (p) => p.severity === "error" && files.some((f) => sameFile(p.file, f)),
  ).length;
}

/**
 * 编译这一批（来自 `autoCompileQueue`，已防抖、已串行）。
 *
 * 返回值和异常都不给队列看：失败已经按类型提示过，队列只需要知道「跑完了」。
 */
export async function runAutoCompile(paths: readonly string[]): Promise<void> {
  const root = getSession().root ?? null;
  const targets = paths.filter((p) => isAutoCompileTarget(p, root));
  if (targets.length === 0) return;
  if (!(await isAutoCompileEnabled())) return;

  // 记下进入前的状态：后端返回「跳过」时我们什么都没编，不能顺手把
  // 正在进行的手动编译的「编译中」标志清掉（状态栏会莫名变成已结束）
  const wasCompiling = getSession().compiling;
  setSession({ compiling: true });
  try {
    const outcome = await compileFile([...targets]);
    if (outcome.status === "skipped") {
      // 手动编译占着闸：等它结束再编，否则这次保存的改动永远不会进产物，
      // 而界面还显示「编译成功」
      if (outcome.code === "busy") requeueAutoCompile(targets);
      else if (outcome.code === "index-cold" && !hintedColdIndex) {
        hintedColdIndex = true;
        toast(outcome.message, "info");
      }
      // `no-module`（工作区根下散放的 .java）静默：那不是错误，也不该每保存一次弹一次
      return;
    }
    // 保存到编译之间可能已经切了工作区：这份结果不能写进新工程的面板
    if ((getSession().root ?? null) !== root) return;
    const before = getSession().compileResult;
    const beforeErrors = errorCountOf(before?.problems ?? [], targets);
    // 用 updater 拿最新值：这一轮跑着的时候手动编译可能刚写完结果
    setSession({ compileResult: (prev) => mergeFileResult(prev, outcome.result, targets) });
    // 同一处错误连续保存只提示第一次：每次 Ctrl+S 弹一下会让人把提示当噪音
    if (outcome.result.errorCount > 0 && beforeErrors === 0) {
      const name = targets.length === 1 ? baseName(targets[0]) : `${targets.length} 个文件`;
      toast(`${name} 有 ${outcome.result.errorCount} 个编译错误（见问题面板）`, "warning");
    }
  } catch (e) {
    if ((getSession().root ?? null) !== root) return;
    // 用户自己点「取消」不该说成「自动编译失败」
    if (!isCompileCancelled(e)) toast(`自动编译失败：${e}`, "error");
  } finally {
    setSession({ compiling: wasCompiling });
  }
}
