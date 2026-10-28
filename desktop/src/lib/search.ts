import { invoke } from "./tauri";

/**
 * 与 Rust `search.rs` 的 serde 结构一一对应（camelCase）。
 * 字段含义见后端模块文档：高亮区间是 **UTF-16 码元**偏移，正好是 JS 字符串下标。
 */
export interface MatchRange {
  start: number;
  end: number;
}

export interface SearchHit {
  /** 相对工作区根、`/` 分隔。 */
  path: string;
  /** 1 起。 */
  line: number;
  /** 已按后端上限截断的行文本。 */
  text: string;
  ranges: MatchRange[];
}

export interface SearchOutcome {
  hits: SearchHit[];
  filesScanned: number;
  filesMatched: number;
  truncated: boolean;
  elapsedMs: number;
}

export interface SearchOptions {
  text: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** IDEA 风格掩码：`*.java,*.xml,!test*`。空串 = 不过滤。 */
  include?: string;
  maxResults?: number;
}

export const searchWorkspace = (options: SearchOptions) =>
  invoke<SearchOutcome>("search_workspace", { options });
