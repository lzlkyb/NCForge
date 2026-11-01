// 删除前的引用检查（「安全删除」的轻量版）。
//
// 不用 `textDocument/references`：那个要求文件已经在 jdt.ls 里打开并且光标落在符号上，
// 而删除是从文件树发起的——被删的文件很可能根本没开过。这里退一步，按**类名**做
// 全工程文本搜索：`\bFoo\b` 在别的 .java 里出现，多半就是引用。它会有误报
// （同名局部变量、注释），但**不会漏**，而删除确认只需要「提醒一下」。
//
// 结论不阻止删除：用户点删除时已经决定了，这里只是让他知道「别处还有 N 处提到它」。
import { baseName } from "./workspace";
import { searchWorkspace } from "./search";

/** 引用命中上限：够判断「有没有别处引用」，太多了列出来也没人看。 */
const MAX_HITS = 200;

export interface RefCheck {
  /** 除自己以外的命中数（上限截断后）。 */
  count: number;
  /** 前几处（相对工作区根，`/` 分隔）。 */
  samples: string[];
  /** 搜索被截断（结果可能不全）。 */
  truncated: boolean;
}

/** 不是 .java 就没有「类名引用」这回事，直接返回 0。 */
export async function checkReferences(path: string): Promise<RefCheck> {
  const name = baseName(path);
  if (!name.toLowerCase().endsWith(".java")) return { count: 0, samples: [], truncated: false };
  const stem = name.slice(0, -5);
  // 类名必须是合法标识符才值得搜（`A$1.java` 这类内部类文件名搜不到引用）
  if (!/^[A-Za-z_$][\w$]*$/.test(stem)) return { count: 0, samples: [], truncated: false };
  const out = await searchWorkspace({
    text: `\\b${stem}\\b`,
    regex: true,
    caseSensitive: true,
    include: "*.java,*.xml",
    maxResults: MAX_HITS,
  });
  const self = path.replace(/\\/g, "/").toLowerCase();
  const others = out.hits.filter((h) => !self.endsWith(`/${h.path.toLowerCase()}`));
  return {
    count: others.length,
    samples: [...new Set(others.map((h) => h.path))].slice(0, 5),
    truncated: out.truncated,
  };
}
