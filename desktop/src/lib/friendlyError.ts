/**
 * IPC 错误 → 人话。
 *
 * 后端抛上来的是 Rust 的英文原文（`failed to start server: os error 2`、
 * `Access denied: C:\… is not within any allowed root`）。数据库页与 SVN 早就各有一套
 * 翻译器（`friendlyDbError` / `friendlySvnError`），服务、补丁、设置这条链却一直把原文
 * 直接弹给用户——恰恰是最需要说清楚的地方（启停服务、写 NC 配置、出包）。
 *
 * 这里只做**基于现象**的通用映射，不解析业务语义：看不懂的就原样返回，
 * 不做「大概是这样」的猜测。原文始终可以在 toast 的「复制全部错误」里拿到。
 */
import { friendlyDbError } from "./db";
import { friendlySvnError } from "./svn";

/** 从任意抛出物里挖出可读文本。 */
export function errorTextOf(e: unknown): string {
  if (e === null || e === undefined) return "";
  if (typeof e === "string") return e.trim();
  if (e instanceof Error) return e.message.trim();
  if (typeof e === "object" && "message" in e) {
    const m = (e as { message: unknown }).message;
    return typeof m === "string" ? m.trim() : String(m);
  }
  return String(e).trim();
}

/** 剥掉无信息量的前缀，留下真正的原因。 */
function stripPrefix(s: string): string {
  return s.replace(/^(Error:\s*|error:\s*)+/, "").trim();
}

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n)}…` : s);

interface Rule {
  re: RegExp;
  text: string;
  /** 把原文附在括号里（原因本身有信息量时用）。 */
  detail?: boolean;
}

/**
 * 顺序有意义：先匹配具体的，最后才是 `not found` 这种泛的。
 * 每条都对应一个真实出现过的报错形态，不是凭空罗列。
 */
const RULES: Rule[] = [
  {
    re: /not within any allowed root|Access denied: .*root/i,
    text: "路径不在允许范围内：只能操作当前工作区与 NC 安装目录下的文件",
  },
  {
    re: /os error 5\b|Access is denied|Permission denied|拒绝访问/i,
    text: "没有权限：文件被系统或其他程序占着，关掉占用它的程序再试",
    detail: true,
  },
  {
    re: /os error 32\b|being used by another process|另一个程序正在使用/i,
    text: "文件正被另一个程序占用：关掉那个程序再试",
  },
  {
    re: /os error 112\b|not enough space|磁盘空间不足/i,
    text: "磁盘空间不足：清一些空间再试",
  },
  {
    re: /os error 3\b|系统找不到指定的路径/i,
    text: "路径不存在：检查目录是否被移走或重命名",
  },
  {
    re: /os error 183\b|already exists|已存在/i,
    text: "目标已存在：先删掉旧的或换个名字",
  },
  {
    re: /os error 2\b|No such file or directory|系统找不到指定的文件|找不到指定的文件/i,
    text: "找不到文件：可能已被移动或删除，刷新一下再试",
  },
  {
    re: /timed out|timeout|超时/i,
    text: "操作超时：目标没响应，检查网络，或看看相关文件是否被占用",
    detail: true,
  },
  {
    re: /connection refused|actively refused|unreachable|拒绝连接/i,
    text: "连不上目标：确认服务在运行、端口没被防火墙挡住",
    detail: true,
  },
  {
    re: /invalid zip|zip.*(corrupt|invalid)|压缩包/i,
    text: "压缩包损坏或不完整：重新下载一次",
  },
  {
    re: /checksum|sha-?256|校验/i,
    text: "下载内容校验不通过：文件可能损坏，重试一次",
  },
  {
    re: /not found|does not exist|不存在/i,
    text: "找不到目标：它可能已经被删除或改名",
    detail: true,
  },
];

export type ErrorDomain = "db" | "svn" | "general";

const hasCjk = (s: string) => /[\u4e00-\u9fa5]/.test(s);

/**
 * 通用翻译。`domain` 只用来优先走已有的专用翻译器（它们的判定比这里细）；
 * 专用翻译器没命中（返回的仍是英文原文）时继续走下面的规则表。
 */
export function friendlyError(e: unknown, domain: ErrorDomain = "general"): string {
  if (domain === "db") return friendlyDbError(e);
  if (domain === "svn") {
    const s = friendlySvnError(e);
    if (hasCjk(s)) return s;
  }
  const raw = stripPrefix(errorTextOf(e));
  if (!raw) return "未知错误";
  for (const r of RULES) {
    if (r.re.test(raw)) return r.detail ? `${r.text}（${clip(raw)}）` : r.text;
  }
  return clip(raw);
}

/** toast 用的完整句子：`<动作>失败：<人话>`。 */
export function failureText(action: string, e: unknown, domain: ErrorDomain = "general"): string {
  return `${action}失败：${friendlyError(e, domain)}`;
}
