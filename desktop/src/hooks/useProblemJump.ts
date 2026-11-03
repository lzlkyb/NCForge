import { toast } from "../components/ui/toast";
import { getCursor } from "../lib/cursorStore";
import { getCodeDiags } from "../lib/diagStore";
import { mergeProblems, nextProblem } from "../lib/problemList";
import type { Problem } from "../lib/compile";

/**
 * 跳上 / 下一条问题。
 *
 * 位置取**执行时刻**的光标，不订阅 `useCursor`——那会让整页随方向键重渲染。
 * 问题表是编译问题 + jdt.ls 代码检查的合并口径，与徽章、列表同一份。
 */
export function useProblemJump(
  compileProblems: Problem[] | undefined,
  activePath: string | null,
  openAt: (path: string, line: number, push?: boolean) => Promise<void>,
) {
  return (dir: 1 | -1) => {
    const list = mergeProblems(compileProblems, getCodeDiags());
    const p = nextProblem(
      list,
      activePath ? { path: activePath, line: getCursor().line } : null,
      dir,
    );
    if (!p) {
      toast("当前没有可跳转的问题", "info");
      return;
    }
    void openAt(p.path, p.line);
  };
}
