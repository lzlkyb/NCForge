/**
 * 把一串编译日志解析成「哪个文件的第几行」。
 *
 * 只认两种确定存在的写法，认不出就返回 null —— 猜错会把人带到不相干的行上，
 * 比不能点更浪费排查时间：
 *
 * 1. ecj 原始输出：`1. ERROR in D:\newar\pm\src\com\x\Foo.java (at line 42)`
 * 2. 前端编译结果追加：`ERROR src\com\x\Foo.java:42 类型 X 的方法 Y() 未定义`
 *
 * **不认 Java 堆栈**（`at com.foo.Bar.baz(Bar.java:42)`）：只有文件名没有目录，
 * 工作区里同名类可能有多个，按名字猜必然指错。
 */

export interface LogLink {
  /** 绝对路径（相对路径已按工作区根拼好）。 */
  path: string;
  line: number;
}

/** ecj batch 的「N. ERROR in <路径> (at line M)」。 */
const ECJ = /^\s*\d+\.\s+(?:ERROR|WARNING)\s+in\s+(.+?)\s+\(at line\s+(\d+)\)/i;

/**
 * `路径:行号` 形态；前面可能带 `ERROR` 前缀。
 *
 * 路径段刻意排除空格与括号：Java 堆栈的 `at com.nc.Foo.bar(Foo.java:42)` 必须匹配不上，
 * 否则会被当成一个叫 `at com.nc.Foo.bar(Foo.java` 的文件。代价是路径本身带空格的工程
 * 这一种写法点不了——但那种路径在 ecj 输出里走的是上面那个 `in … (at line N)` 分支，不会漏。
 */
const COLON = /^(?:ERROR\s+)?([^\s()<>|"]+\.(?:java|xml|properties|jsp))[:(](\d+)/i;

function isAbsolute(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}

function joinPath(root: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  const a = root.replace(/[\\/]+$/, "");
  const b = rel.replace(/^[\\/]+/, "");
  return `${a}${sep}${b}`;
}

/**
 * 解析一行日志。`root` 用来拼相对路径，传空串时相对路径的日志一律不认
 * （没有根就没法打开，硬拼出来只会报「文件不存在」）。
 */
export function parseLogLink(text: string, root: string): LogLink | null {
  const s = text.trim();
  if (!s) return null;
  const m = ECJ.exec(s) ?? COLON.exec(s);
  if (!m) return null;
  const raw = m[1].trim().replace(/^["']|["']$/g, "");
  const line = Number(m[2]);
  if (!raw || !Number.isFinite(line) || line < 1) return null;
  if (isAbsolute(raw)) return { path: raw.replace(/\//g, "\\"), line };
  if (!root) return null;
  return { path: joinPath(root, raw), line };
}
