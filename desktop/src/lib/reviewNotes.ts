/**
 * 「复制给 Claude」：把选中的代码 / 一处改动块连同 `file:line` 拼成 Markdown，写进剪贴板。
 *
 * 边界（方案 §8）：只做剪贴板，**不接 AI、不自动发送、不落盘、不跟读 audit.log**。
 * AI 在 cc-bridge 那头，用户自己决定贴到哪。这是批次 C 里唯一值得留下的一部分，
 * 已降级并入 B1：版本控制面、代码面浮层、时间线三处共用同一份渲染。
 */

export interface ReviewNote {
  path: string;
  line: number;
  text: string;
  comment?: string;
}

/** 展示用相对路径；不在工作区里就原样给绝对路径。 */
export function relativeDisplay(path: string, root: string | null | undefined): string {
  const a = path.replace(/\\/g, "/");
  if (!root) return a;
  const b = root.replace(/\\/g, "/").replace(/\/$/, "");
  // 必须落在目录边界上：`C:/w` 与 `C:/work/x.java` 只差一个前缀词，
  // 不判分隔符会把别处的文件显示成工作区相对路径（"ork/x.java"）。
  const inside = a.length > b.length
    && a.slice(0, b.length).toLowerCase() === b.toLowerCase()
    && a[b.length] === "/";
  return inside ? a.slice(b.length + 1) : a;
}

function fenceOf(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".sql")) return "sql";
  if (lower.endsWith(".xml") || lower.endsWith(".html")) return "xml";
  if (lower.endsWith(".json")) return "json";
  return "java";
}

/** 纯函数，单测直接比对字符串；不依赖剪贴板 API。 */
export function renderReviewNotes(
  notes: readonly ReviewNote[],
  root: string | null | undefined = null,
): string {
  if (notes.length === 0) return "";
  const body = notes
    .map((n) => {
      const loc = `${relativeDisplay(n.path, root)}:${n.line}`;
      const code = n.text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
      const f = "```";
      const comment = n.comment?.trim() ? `\n\n> ${n.comment.trim()}` : "";
      return `### ${loc}\n\n${f}${fenceOf(n.path)}\n${code}\n${f}${comment}`;
    })
    .join("\n\n");
  return `## 代码审查批注\n\n${body}\n\n---\n请逐条核对以上位置，说明改动理由与影响范围。`;
}

/** 复制到剪贴板；浏览器不允许时退回临时 textarea。返回是否成功。 */
export async function copyReviewNotes(
  notes: readonly ReviewNote[],
  root: string | null | undefined = null,
): Promise<boolean> {
  const text = renderReviewNotes(notes, root);
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}
