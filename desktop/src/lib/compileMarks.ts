import type { Problem } from "./compile";

/**
 * 编译错误在树 / 标签上的标记数据。
 *
 * 编译器给的是「文件 + 行」；树是目录树，用户要先看到「哪个包/模块有错」，
 * 再展开找文件。所以一次遍历把文件计数累加到它的每一层父目录（含工作区根），
 * 树和标签都只做 O(1) 查表。
 *
 * 路径统一按 `/`、小写比较：编译器输出、文件树、标签可能混用 `\` 与不同盘符大小写。
 */
export interface ProblemMark {
  errors: number;
  warnings: number;
}

const EMPTY: ReadonlyMap<string, ProblemMark> = new Map();

export const markKey = (path: string) =>
  path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** 工作区路径 → 该文件/目录下（含更深层）的错误与警告数。 */
export function buildCompileMarks(
  problems: readonly Problem[],
  root: string,
): ReadonlyMap<string, ProblemMark> {
  const r = markKey(root);
  if (!r) return EMPTY;
  const map = new Map<string, ProblemMark>();
  const bump = (key: string, errors: number, warnings: number) => {
    const cur = map.get(key) ?? { errors: 0, warnings: 0 };
    map.set(key, { errors: cur.errors + errors, warnings: cur.warnings + warnings });
  };

  for (const p of problems) {
    if (!p.file) continue;
    const file = markKey(p.file);
    // 关联工程在工作区之外：它们的错误不能挂到当前树的同名目录上
    if (!file.startsWith(`${r}/`)) continue;
    const errors = p.severity === "error" ? 1 : 0;
    const warnings = errors ? 0 : 1;
    bump(file, errors, warnings);
    let cut = file.lastIndexOf("/");
    while (cut >= r.length) {
      const dir = file.slice(0, cut);
      bump(dir, errors, warnings);
      if (dir.length === r.length) break;
      cut = dir.lastIndexOf("/");
    }
  }
  return map;
}

/** 在标记表里查路径；没有就返回 undefined（行组件据此不渲染徽标）。 */
export function markOf(
  marks: ReadonlyMap<string, ProblemMark>,
  path: string,
): ProblemMark | undefined {
  return marks.get(markKey(path));
}
