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

/** 单个工程的搜索结果（`search_projects` 的一项）。`outcome` 里的路径相对 `root`。 */
export interface ProjectSearch {
  project: string;
  /** 工程根绝对路径。 */
  root: string;
  outcome: SearchOutcome;
}

/**
 * 「全部工程」搜索的结果。
 *
 * 后端按工程逐个扫描并分别计时：一个工程超时/读盘失败不该把其余工程的结果一起吞掉，
 * 所以错误单独收集，界面才能说清「哪几个工程没搜完」。
 */
export interface ProjectsSearchOutcome {
  projects: ProjectSearch[];
  /** 读取失败的工程（`工程名: 原因`），其余工程的结果仍然有效。 */
  errors: string[];
  /** 任一工程（或总预算）提前停下。 */
  truncated: boolean;
  elapsedMs: number;
}

/** 同一个文件可能出现在多个工程里，结果必须带上工程归属才能拼出绝对路径。 */
export interface ProjectSearchHit extends SearchHit {
  project: string;
  root: string;
}

export const searchProjects = (options: SearchOptions) =>
  invoke<ProjectsSearchOutcome>("search_projects", { options });

/**
 * 「全部替换」的汇总，与 Rust `search::ReplaceOutcome` 一一对应（camelCase）。
 */
export interface ReplaceOutcome {
  /** 实际被改写的文件数。 */
  filesChanged: number;
  /** 替换了多少处。 */
  replacements: number;
  /** 实际读过的文件数。 */
  filesScanned: number;
  /**
   * 编码无法无损往返或换行混合、被跳过的文件数。
   *
   * 跳过而不是硬改：按检测出的编码写回去，会让原文件里原本就有的「乱码字节」
   * 被规范化，等于顺手破坏了别人的文件。
   */
  skippedUnsafe: number;
  /** 读写失败的文件（路径 + 原因），最多 20 条。 */
  errors: string[];
  /** 是否因时间预算提前结束（此时「没改的文件」不代表「没有匹配」）。 */
  truncated: boolean;
  elapsedMs: number;
}

/**
 * 在工作区内替换全部命中。范围与 `searchWorkspace` 完全一致（同一套候选收集）。
 *
 * 不让前端逐个文件改：编码与换行必须按原文件还原（NC 工程 GBK/UTF-8 混放、
 * 还有混合换行的老文件），这些逻辑后端已经有一份且被单测覆盖。
 */
export const replaceWorkspace = (options: SearchOptions, replacement: string) =>
  invoke<ReplaceOutcome>("search_replace", { options, replacement });
