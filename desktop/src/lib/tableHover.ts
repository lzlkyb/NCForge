import type { TableLookup } from "./tableLookup";

/**
 * 编辑器里「悬停表名看表结构」的纯逻辑。
 *
 * 只做文本层面的判断，不发请求：Monaco 的 hover 在鼠标移动时就会触发，
 * 先把「光标下这个词到底是不是表名」算清楚，确认是了再去要字段。
 */

/** 光标所在的完整标识符，带上它在行内的起止下标（0 基，左闭右开）。 */
export function wordSpan(
  line: string,
  column: number,
): { word: string; start: number; end: number } {
  const i = Math.max(0, Math.min(column - 1, line.length));
  const isId = (c: string) => /[A-Za-z0-9_$#]/.test(c);
  let s = i;
  while (s > 0 && isId(line[s - 1])) s--;
  let e = i;
  while (e < line.length && isId(line[e])) e++;
  return { word: line.slice(s, e), start: s, end: e };
}

/** 光标所在的完整标识符（取光标左侧与右侧的连续标识符字符拼起来）。 */
export function wordAt(line: string, column: number): string {
  return wordSpan(line, column).word;
}

/**
 * 这一列位置是不是在 Java 字符串字面量里。
 *
 * 只看单行：NC 的 SQL 常量几乎都写在一行里（跨行的部分靠 `+` 拼接），
 * 要精确判断得解析整个文件，代价不划算。
 */
export function inStringLiteral(line: string, column: number): boolean {
  let n = 0;
  for (let i = 0; i < Math.min(column - 1, line.length); i++) {
    if (line[i] === "\\") {
      i++; // 跳过转义的下一个字符，`\"` 不计入引号
      continue;
    }
    if (line[i] === '"') n++;
  }
  return n % 2 === 1;
}

const NOT_ALIAS = new Set([
  "where", "on", "and", "or", "set", "values", "group", "order", "having",
  "left", "right", "inner", "outer", "cross", "full", "join", "union", "using",
  "start", "connect", "limit", "asc", "desc",
]);

/** 把表名/别名里的正则元字符转义（表名一般没有，但 `$` 在标识符里合法）。 */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 同一行 SQL 里，这张表被点出来过的某个列名（用于在卡片里把它排到最前）。
 *
 * 认两种写法：`from pam_equip e` 之后用 `e.xxx`，以及直接 `pam_equip.xxx`。
 * 找不到就返回 null——这不是错误，只是没有可以高亮的列。
 */
export function columnForTable(line: string, table: string): string | null {
  const t = esc(table);
  const aliasRe = new RegExp(`\\b${t}\\s+(?:as\\s+)?([A-Za-z_][\\w$#]*)`, "i");
  const m = aliasRe.exec(line);
  const alias = m && !NOT_ALIAS.has(m[1].toLowerCase()) ? m[1] : null;
  for (const q of alias ? [t, esc(alias)] : [t]) {
    const hit = new RegExp(`\\b${q}\\s*\\.\\s*([A-Za-z_][\\w$#]*)`, "i").exec(line);
    if (hit) return hit[1];
  }
  return null;
}

/** 秒数 → 「2 小时前」。缓存时间的展示，界面上到处都是。 */
export function agoText(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return "刚刚";
  if (secs < 60) return "刚刚";
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

// ───────────────── hover 内容 ─────────────────

/** 浮层里最多列几个字段——再多就超出 Monaco 的高度，看着像被切了。 */
export const HOVER_MAX_FIELDS = 12;

/**
 * 「在数据库中打开」用的命令 id。
 *
 * 三处必须一致：这里生成的链接、`monacoSetup` 的 `addCommand`、以及
 * `isTrusted.enabledCommands` 白名单。写错任何一处都表现为「点了没反应」。
 */
export const OPEN_TABLE_COMMAND = "ncforge.openTable";

/**
 * 生成「在数据库中打开」的 command 链接。
 *
 * Monaco 的解析规则（`browser/services/openerService.js` 的 CommandOpener）：
 * `command:<命令 id>?<query>`，query 会 `decodeURIComponent` 后按 JSON 解析，
 * 结果必须是数组（命令参数按位置展开）。所以表名走 `JSON.stringify([表名])` 再编码。
 *
 * 抽成函数是为了能单测——链接格式错一个字，界面上只是"点了没反应"。
 */
export function openTableLink(table: string): string {
  return `[在数据库中打开](command:${OPEN_TABLE_COMMAND}?${encodeURIComponent(JSON.stringify([table]))})`;
}

export interface HoverPayload {
  /** 命中的词在行内的起止（0 基，左闭右开）。 */
  start: number;
  end: number;
  /** Markdown 正文。 */
  markdown: string;
}

/**
 * 算出「光标这一处该不该弹表结构、弹什么」。
 *
 * 抽出来是为了能单测：Monaco 的 provider 注册只能在真机上验，但内容拼装
 * （哪一列排最前、超了多少个字段、缓存时间写在哪）不该靠肉眼看。
 */
export async function buildTableHover(
  line: string,
  column: number,
  lookup: TableLookup,
): Promise<HoverPayload | null> {
  // 只认字符串字面量里的词：`String pam_equip` 这种 Java 标识符不该弹表结构
  if (!inStringLiteral(line, column)) return null;
  const { word, start, end } = wordSpan(line, column);
  if (word.length < 3 || !lookup.has(word)) return null;

  const cols = await lookup.columns(word);
  if (!cols || cols.length === 0) return null;

  // 同一行里被点出来的那个列排到最前，省得人自己找
  const hit = columnForTable(line, word)?.toLowerCase();
  const head = hit ? cols.filter((c) => c.name.toLowerCase() === hit) : [];
  const rest = cols.filter((c) => !head.includes(c));
  const shown = [...head, ...rest].slice(0, HOVER_MAX_FIELDS);
  const body = shown.map((c) => `| \`${c.name}\` | ${c.type} |`).join("\n");
  const more = cols.length > shown.length ? `\n\n还有 ${cols.length - shown.length} 个字段` : "";
  const age = lookup.cacheAge();

  return {
    start,
    end,
    markdown:
      `**${word}** · 表 · ${cols.length} 个字段\n\n` +
      `| 字段 | 类型 |\n| --- | --- |\n${body}${more}` +
      (age ? `\n\n---\n表结构缓存 · ${age}` : "") +
      `\n\n${openTableLink(word)}`,
  };
}
