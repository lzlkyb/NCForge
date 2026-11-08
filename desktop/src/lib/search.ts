import { invoke, listen } from "./tauri";
import { trackOperation } from "./operations";
import { getSession } from "./workspaceSession";

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
  /** 本次真正生效的范围（工作区相对、`/` 分隔）；空 = 整个工作区。 */
  scopeDirs: string[];
  /** 请求了但磁盘上不存在的目录（组件被删/改名时会出现在这里）。 */
  missingDirs: string[];
  /** 请求的范围一个都不存在 → 后端已回落成整个工作区。 */
  scopeFallback: boolean;
  /** 被同来源的新搜索或 `cancelSearch` 打断；结果不完整，不能当成「没搜到」。 */
  cancelled?: boolean;
}

/** 取消某个来源正在跑的搜索（没有就什么也不做）。失败只是没停下，不影响界面。 */
export const cancelSearch = (source: string) => invoke("search_cancel", { source }).catch(() => {});

export interface SearchOptions {
  text: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** IDEA 风格掩码：`*.java,*.xml,!test*`。空串 = 不过滤。 */
  include?: string;
  /**
   * 把范围收窄到这些**工作区相对的目录**（空/不传 = 整个工作区）。
   *
   * 只用于「按业务组件搜索」：manifest 告诉我们哪些目录是组件，范围就是它们。
   * 后端不接受绝对路径与 `..`（范围只能收窄，不能跳出工作区）。
   */
  dirs?: string[];
  maxResults?: number;
  /**
   * 优先扫描的文件（**相对工作区根**、`/` 或 `\` 分隔）。
   *
   * 只影响扫描顺序、不影响范围与结果集：快速面板把它设成最近打开的那些文件，
   * 用户多半在找刚看过的东西，第一条命中就能在几十毫秒内出现。
   */
  priority?: string[];
  /**
   * 未保存的文档内容（overlay）。**不要手填**：`searchWorkspace` / `searchWorkspaceStream`
   * 会通过 `installSearchOverlay` 注册的 provider 自动注入。
   */
  overlay?: OverlayDoc[];
}

/** 一份未保存的文档。`path` 是**工作区相对**路径（`/` 分隔）。 */
export interface OverlayDoc {
  path: string;
  text: string;
}

/**
 * overlay 数据源。用「注册」而不是直接 import `editorStore`：后者会把 Monaco 拖进
 * 任何 import 了本模块的 jsdom 测试（见 `docs/` 里组件测试的 mock 约定）。
 */
let overlayProvider: (() => OverlayDoc[]) | null = null;

/** 由 `lib/searchOverlay.ts` 在应用启动时调用一次。 */
export function setOverlayProvider(fn: (() => OverlayDoc[]) | null): void {
  overlayProvider = fn;
}

function withOverlay(options: SearchOptions): SearchOptions {
  if (!overlayProvider) return options;
  const docs = overlayProvider();
  return docs.length ? { ...options, overlay: docs } : options;
}

/**
 * `source`：调用方标识。同来源的新搜索会让后端取消旧的那次扫描（旧结果带 `cancelled`）；
 * 不传则与其它搜索互不影响。
 */
export const searchWorkspace = (options: SearchOptions, report = false, source?: string) => {
  const opts = withOverlay(options);
  return !report ? invoke<SearchOutcome>("search_workspace", source ? { options: opts, source } : { options: opts }) : trackOperation({ key: `search.workspace:${getSession().root}:${JSON.stringify(opts)}`, label: "搜索当前工程", errorDetail: () => "搜索失败，请查看搜索页错误详情", scope: getSession().root ?? "工作区", page: "search", phase: "扫描所选范围，保留已有结果" }, () => invoke<SearchOutcome>("search_workspace", { options: opts }), r => ({ state: "success", detail: `扫描 ${r.filesScanned} 个文件，命中 ${r.filesMatched} 个${r.truncated ? "；达到上限，结果不完整" : ""}${r.scopeFallback ? "；指定范围不存在，已回落到整个工作区" : ""}` }));
};

/** 一批流式结果。`stream` 是查询标识：连续敲键会有多次查询同时在飞。 */
interface SearchBatch {
  stream: string;
  hits: SearchHit[];
}

let streamSeq = 0;

/**
 * 流式搜索：边扫边把新命中交给 `onBatch`，返回值仍是完整结果。
 *
 * 为什么要分批：快速面板的 `#内容` 以前是「发出去就一直等到扫完」，newar 上要
 * 1~3 秒，列表始终空着，看起来像卡死。现在第一批命中几十毫秒就到，用户能看到
 * 列表在长；`onBatch` 收到的是**增量**，最终以返回值为准（事件可能在返回之后才到，
 * 所以调用方拿到 Promise 结果后要整体替换列表，而不是继续追加）。
 */
export async function searchWorkspaceStream(
  options: SearchOptions,
  onBatch: (hits: SearchHit[]) => void,
  source?: string,
): Promise<SearchOutcome> {
  const stream = `s${++streamSeq}`;
  const opts = withOverlay(options);
  let un: (() => void) | undefined;
  try {
    un = await listen<SearchBatch>("search:batch", (p) => {
      if (p.stream === stream) onBatch(p.hits);
    });
  } catch {
    // 浏览器里跑 vite dev 时 listen 会失败：退化成「只拿最终结果」
  }
  try {
    return await invoke<SearchOutcome>("search_workspace_stream", { options: opts, source, stream });
  } finally {
    un?.();
  }
}

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
  trackOperation({ key: `search.projects:${getSession().root}:${JSON.stringify(options)}`, label: "搜索全部工程", errorDetail: () => "搜索失败，请查看搜索页错误详情", page: "search", phase: "逐工程扫描所选范围" }, () => invoke<ProjectsSearchOutcome>("search_projects", { options }), r => ({ state: r.errors.length ? "failed" : "success", detail: `${r.projects.length} 个工程返回结果；${r.errors.length} 个工程读取失败${r.truncated ? "；结果达到上限，未查全" : ""}` }));

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
  trackOperation({ key: `search.replace:${getSession().root}`, label: "替换工程中的匹配", errorDetail: () => "替换失败，请查看搜索页错误详情", scope: getSession().root ?? "工作区", page: "search", phase: "按预览范围读写文件，保留原编码" }, () => invoke<ReplaceOutcome>("search_replace", { options, replacement }), r => ({ state: r.errors.length ? "failed" : "success", detail: `改写 ${r.filesChanged} 个文件、替换 ${r.replacements} 处；跳过 ${r.skippedUnsafe} 个不安全编码文件，${r.errors.length} 个失败${r.truncated ? "；提前结束，尚未全部替换" : ""}` }));
