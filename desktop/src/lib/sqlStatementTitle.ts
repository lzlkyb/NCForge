/**
 * 语句标题：把紧贴在语句前面的那行注释当成它的名字。
 *
 * 结果标签现在只能叫「查询 3 / 语句 5」，脚本一跑就是七八个标签，想回到某个结果
 * 得靠猜序号。DataGrip 的做法是 `-- name: xxx` 注释给结果标签命名；这里放宽成
 * 「紧贴的注释第一行就是名字」，同时保留 `name:` 这类显式前缀做优先。
 *
 * 🔴 三条判据，改动前先看：
 * 1. **必须紧贴**——注释与语句之间不能有空行。脚本顶部的 `-- 2026-11 升级脚本`
 *    和语句之间隔了空行，那是整篇的说明，不是某条语句的名字。不拦这一条，第一条
 *    SELECT 会顶着「2026-11 升级脚本」的标签。
 * 2. **只取第一段注释、第一行有内容的文本**。`-- 物料主档` 后面跟 `-- 只在测试库跑`
 *    这类补充说明时不合并，标签保持短。
 * 3. 纯分隔线（`-----`、`====`、`***`）和纯标点不算名字，否则满屏标签叫「-----」。
 */

/** `name: 物料主档` / `名称：物料主档` / `title: ...` 这类显式前缀，优先于整行文字。 */
const PREFIX = /^(?:name|title|名称|标题|说明)\s*[:：]\s*/i;
/** 分隔线与装饰线：只由这些字符组成的注释不是名字。 */
const DECORATION = /^[-=*_~#\s]+$/;

/** 注释与语句之间允许的最大空白：出现空行（`\n` 之间只有空白）就不算紧贴。 */
const GAP_WITH_BLANK_LINE = /\n[ \t]*\r?\n/;

interface LeadingComment {
  text: string;
  /** 注释结束位置。 */
  end: number;
  block: boolean;
}

/** 读开头第一段注释（跳过前导空白）；不是注释开头返回 null。 */
function leadingComment(sql: string): LeadingComment | null {
  let i = 0;
  while (i < sql.length && /\s/.test(sql[i])) i++;
  if (sql.startsWith("--", i)) {
    // `--+ parallel(4)` 与 `/*+ ... */` 一样是 hint
    if (sql[i + 2] === "+") return null;
    const nl = sql.indexOf("\n", i);
    const end = nl < 0 ? sql.length : nl;
    return { text: sql.slice(i + 2, end), end, block: false };
  }
  if (sql.startsWith("/*", i)) {
    // `/*+ index(t idx) */` 是 hint，不是给语句起的名字：拿它当标签会显示「+ index(t idx)」
    if (sql[i + 2] === "+") return null;
    const close = sql.indexOf("*/", i + 2);
    return { text: sql.slice(i + 2, close < 0 ? sql.length : close), end: close < 0 ? sql.length : close + 2, block: true };
  }
  return null;
}

/**
 * 取第一行有内容的文本。
 * 只有块注释才剥行首的 `*`——单行注释里的 `**重点**` 是用户自己写的强调，别动。
 */
function firstLine(text: string, block: boolean): string {
  for (const line of text.split(/\r?\n/)) {
    const cleaned = (block ? line.replace(/^\s*\*+\s?/, "") : line).trim();
    if (cleaned) return cleaned;
  }
  return "";
}

/**
 * 语句的显示标题；没有可用的紧贴注释返回 null（调用方保留原来的「查询 N」）。
 *
 * `max` 是字符数上限，超出用省略号收尾。按码点截断，不会把代理对切坏。
 */
export function statementTitle(sql: string, max = 28): string | null {
  const comment = leadingComment(sql);
  if (!comment) return null;
  // 注释到语句之间有空行 ⇒ 那是段落说明，不是这条语句的名字
  if (GAP_WITH_BLANK_LINE.test(sql.slice(comment.end))) return null;
  const raw = firstLine(comment.text, comment.block);
  if (!raw || DECORATION.test(raw)) return null;
  const name = raw.replace(PREFIX, "").trim();
  if (!name || DECORATION.test(name)) return null;
  const chars = [...name];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : name;
}
