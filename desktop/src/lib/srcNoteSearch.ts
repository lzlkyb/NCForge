// jar 内**源码注释**搜索：让 NC 随包发布的 `_src.jar` 里的中文注释可被搜到。
//
// 与 `jarSymbolSearch` 是两套互补的索引：
// - `jarSymbolSearch` 搜 class 常量池（类名 / 方法 / 字段 / 字符串常量）——编译产物；
// - 这里搜 `.java` 源码里的注释——**class 里物理上不存在**（javac 编译时剥离）。
//
// 打开时走 jdt.ls 的 source lookup：它自己会找到与编译 jar 同名的 `_src.jar`，
// 所以用户看到的是带注释的原始源码，而不是 CFR 反编译结果。
import { invoke } from "./tauri";

export interface SrcNoteHit {
  /** 源码包（`_src.jar`）的绝对路径。 */
  jar: string;
  /** 包内路径，如 `nc/pub/ba/update/BAPUpdateDB.java`。 */
  path: string;
  /** 注释起始行（1-based）。 */
  line: number;
  /** 注释正文（去标记、多行拼一行）。 */
  text: string;
}

export interface SrcNoteResult {
  items: SrcNoteHit[];
  /**
   * **本次命中多少条注释**（不是索引里的注释总数——那个数是 30 万量级，报出来
   * 只会让人以为被截断了）。同一条注释里 needle 出现多次只算一条，所以它可能
   * 大于 `items.length`（后者受 limit 截断）。
   */
  total: number;
  /** 还有更多没列出来：`limit` 截断**或**扫描超预算，二者都算。 */
  truncated: boolean;
  building: boolean;
  stale: boolean;
  /**
   * 索引建立失败的原因（磁盘满 / 杀软占用索引文件）。
   *
   * 可选：后端还没落地时缺省。有值时界面必须说「建失败 + 怎么办」，
   * 不能继续显示「正在后台建立」——那是永远等不到的假进度。
   */
  error?: string;
  elapsedMs: number;
}

/** 首屏条数；「加载更多」翻倍到 `JAR_SEARCH_MAX_LIMIT`（后端同一个 clamp）。 */
export const SRC_NOTE_LIMIT = 40;

export const searchSrcNotes = (query: string, limit = SRC_NOTE_LIMIT) =>
  invoke<SrcNoteResult>("search_src_notes", { query, limit });

/** 包内路径 → 点形类名：`nc/vo/Foo.java` → `nc.vo.Foo`。 */
export function srcNoteClass(path: string): string {
  return path.replace(/\.java$/, "").replace(/\//g, ".");
}
