/**
 * D1：把编译/诊断问题与「本轮改动范围」求交，得到审查清单要报的错误。
 *
 * 修 P1-7：原实现只留「当前文件且落在改动行」的问题，把 AI 最典型的错误
 * （改了方法签名 / 删了类，编译错误落在**别的文件或调用点**）全部过滤掉了。
 * 现在按本轮文件范围收集，再用 `inChangedArea` 标出哪些确实落在当前文件改动行上：
 * - 改动区错误 = 一眼可见，优先排前面；
 * - 本轮其他文件的错误 = 仍然列出，只是不冒充「改动区」。
 *
 * 两条硬规则继续守 `compileMarkers.ts`：
 * - 不重复画：这里**只产出列表**，波浪线与 Error Lens 仍由各自 owner 负责；
 * - 与 jdt.ls 同位置同原文的条目去重（ecj 与语言服务常指同一处）。
 */
import type { Problem } from "./compile";
import type { CodeDiag } from "./diagStore";
import { isChangedLine, type ChangedSnapshot } from "./changedLines";

export interface ChangedProblem {
  path: string;
  line: number;
  message: string;
  severity: "error" | "warning";
  source: "ecj" | "jdt.ls";
  /** 落在当前文件改动行内；其余是「本轮其他文件」的错误。 */
  inChangedArea: boolean;
}

const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();

/**
 * @param activePath 当前在代码面打开的文件（用来判「改动区」）
 * @param scopePaths 本轮涉及的文件；为空时退化为只看当前文件
 */
export function problemsInChangedArea(
  activePath: string,
  scopePaths: readonly string[],
  problems: readonly Problem[],
  inspect: readonly CodeDiag[],
  snap: ChangedSnapshot,
): ChangedProblem[] {
  const scope = new Set(scopePaths.map(norm));
  if (!scope.size && activePath) scope.add(norm(activePath));
  if (!scope.size) return [];
  const file = norm(activePath);
  const seen = new Set<string>();
  const out: ChangedProblem[] = [];
  const add = (
    path: string, line: number, message: string,
    severity: "error" | "warning", source: "ecj" | "jdt.ls",
  ) => {
    const key = `${norm(path)}|${line}|${message.trim()}`;
    if (!Number.isFinite(line) || !scope.has(norm(path)) || seen.has(key)) return;
    seen.add(key);
    out.push({
      path,
      line,
      message: message.trim(),
      severity,
      source,
      inChangedArea: norm(path) === file && !snap.tooBig && isChangedLine(snap, line),
    });
  };
  for (const p of problems) add(p.file, p.line, p.message, p.severity, "ecj");
  for (const d of inspect) {
    add(d.path, d.line, d.message, d.severity === "error" ? "error" : "warning", "jdt.ls");
  }
  return out.sort((a, b) =>
    Number(b.inChangedArea) - Number(a.inChangedArea)
    || a.path.localeCompare(b.path)
    || a.line - b.line,
  );
}
