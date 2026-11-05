// TODO / FIXME / XXX / HACK 扫描。
//
// 复用全工程搜索（后端 `search_workspace`）而不是自己走盘：那套已经有编码探测、
// 跳过 .svn、二进制识别、时间预算，重写一份只会更慢更容易错。
//
// 不做「打开即扫」：newar 7000 个文件一次扫描是秒级到十秒级，每次点开面板都跑一遍
// 是不可接受的。缓存按工作区存，用户点「重新扫描」才重来。
import { searchWorkspace } from "./search";

export type TodoTag = "TODO" | "FIXME" | "XXX" | "HACK";

export interface TodoItem {
  /** 相对工作区根、`/` 分隔。 */
  path: string;
  line: number;
  tag: TodoTag;
  /** 标签后面的说明（已 trim）。 */
  text: string;
}

/** 只认注释里的标签，避免把字符串常量 `"TODO"` 当成任务。 */
const TAG_RE = /(?:\/\/|\/\*|\*)\s*(TODO|FIXME|XXX|HACK)\b\s*[:：]?\s*(.*)$/;

let cache: { root: string; at: number; items: TodoItem[]; truncated: boolean } | null = null;

export interface TodoScanResult {
  items: TodoItem[];
  truncated: boolean;
  /** 命中条数上限之外的还有多少没列出来（搜索接口只告诉你截断了）。 */
  scannedAt: number;
}

/**
 * 扫描工作区。`force` = 忽略缓存（用户点「重新扫描」）。
 *
 * 结果按「标签 + 路径 + 行」去重：同一行同时命中两条规则的情况确实存在（`// TODO FIXME`）。
 */
export async function scanTodos(root: string, force = false): Promise<TodoScanResult> {
  if (!force && cache && cache.root === root) {
    return { items: cache.items, truncated: cache.truncated, scannedAt: cache.at };
  }
  const out = await searchWorkspace({
    text: "TODO|FIXME|XXX|HACK",
    regex: true,
    caseSensitive: true,
    // 只扫源码与配置：注释标签在 .class / 图片里没有意义，扫它们纯属浪费预算
    include: "*.java,*.xml,*.js,*.ts,*.sql,*.properties,*.upm,*.bmf",
    maxResults: 2000,
  });
  const items: TodoItem[] = [];
  const seen = new Set<string>();
  for (const h of out.hits) {
    const m = TAG_RE.exec(h.text);
    if (!m) continue;
    const key = `${h.path.toLowerCase()}#${h.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      path: h.path,
      line: h.line,
      tag: m[1] as TodoTag,
      text: m[2].trim() || h.text.trim(),
    });
  }
  cache = { root, at: Date.now(), items, truncated: out.truncated };
  return { items, truncated: out.truncated, scannedAt: cache.at };
}

/** 当前缓存（面板首帧用，没有就是空）。 */
export function cachedTodos(root: string): TodoScanResult | null {
  if (!cache || cache.root !== root) return null;
  return { items: cache.items, truncated: cache.truncated, scannedAt: cache.at };
}
