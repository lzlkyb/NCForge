import type {
  ProjectsSearchOutcome,
  ReplaceOutcome,
  SearchOptions,
  SearchOutcome,
} from "./search";

/**
 * 搜索范围：全部关联工程 / 当前工作区。
 *
 * 默认全部工程：依赖链上的改动（接口在 A 工程、调用在 B 工程）是 NC 二开的日常，
 * 只搜当前工程会把跨工程引用漏掉。替换与「编辑匹配」仍只对当前工作区开放——
 * 一次改写多个工程不可撤销，且确认框列不清跨工程改动面。
 */
export type SearchScope = "all" | "current";

/**
 * 搜索页的状态仓库（模块级，不随组件卸载消失）。
 *
 * 页面是按 tab 切的：`ErrorBoundary key={activeTab}` 一换 tab 就把整棵子树卸载，
 * 组件里的 useState 全丢。而「搜到结果 → 点进去改代码 → 切回搜索继续看」是这个
 * 功能最核心的动线，结果一丢等于每次都要重搜（7000 个文件约 0.6s，代价不高但
 * 折叠状态、滚动位置、当前命中全没了）。所以把搜索态放这里。
 *
 * 只存可序列化的搜索态，不放 DOM 引用。
 */
export interface SearchForm {
  query: string;
  /** IDEA 风格掩码。 */
  include: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** 搜索范围：默认全部关联工程。 */
  scope: SearchScope;
  outcome: SearchOutcome | null;
  /**
   * 全部工程的结果。与 `outcome` 互斥：哪个取决于发起搜索时的 `scope`。
   * 分开存是因为替换 / 编辑匹配只认 `outcome`（当前工作区）。
   */
  projectOutcome: ProjectsSearchOutcome | null;
  /**
   * 这份结果是在哪个工作区下搜出来的。
   *
   * 结果里存的是相对路径，点命中时要用**当前** root 拼绝对路径。换过工作区还留着
   * 旧结果的话，点一下就是拿旧相对路径拼新 root，被白名单拒掉、弹一串英文错误。
   */
  outcomeRoot: string | null;
  /**
   * 产出 `outcome` 时用的搜索条件（快照）。
   *
   * 「全部替换」必须拿它执行，不能拿表单的实时值：用户搜完 foo、把输入框改成
   * bar 再点替换时，确认框列的仍是 foo 的改动面，而按 bar 执行会改写另一批文件
   * ——不可撤销的错配。条件变了就禁用替换，要求重新搜索。
   */
  outcomeOptions: SearchOptions | null;
  /**
   * 搜索在跑。放仓库里（而不是组件 state）：切页会卸载组件，loading 归 false，
   * 而后端那次全盘扫描还在跑——回来再点一次就是两个扫描并行。
   */
  running: boolean;
  /** 折叠起来的文件路径。 */
  collapsed: string[];
  /** 后端报错（多半是正则语法错）。 */
  error: string | null;
  /**
   * 「替换为」的输入。
   *
   * 放仓库而不是组件 state：替换是「搜 → 看结果 → 改」的连续动作，
   * 中途切到文件页看一眼再回来，输入不该丢。
   */
  replacement: string;
  /**
   * 替换在跑。与 `running` 同一个理由：切页会卸载组件，后端那次全量写盘不会停，
   *  loading 归 false 会让人以为没在跑而再点一次。
   */
  replacing: boolean;
  /**
   * 最近一次替换的结果。
   *
   * 留着是为了说一句话：**磁盘已经变了，屏幕上的搜索结果过期了**。
   * 不自动清空搜索结果（用户可能还想看改之前的样子），但要把「重新搜索」摆出来。
   */
  replaceOutcome: ReplaceOutcome | null;
}

const EMPTY: SearchForm = {
  query: "",
  include: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  scope: "all",
  outcome: null,
  projectOutcome: null,
  outcomeRoot: null,
  outcomeOptions: null,
  running: false,
  collapsed: [],
  error: null,
  replacement: "",
  replacing: false,
  replaceOutcome: null,
};

let form: SearchForm = { ...EMPTY };

/**
 * 滚动位置不进 `form`：它每秒被 onScroll 写几十次，进快照会让整页跟着重渲染。
 * 只需要在重挂载时恢复一次，所以单独存。
 */
let scrollTop = 0;
export const getSearchScrollTop = (): number => scrollTop;
export const setSearchScrollTop = (v: number): void => {
  scrollTop = v;
};

const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

/** 订阅搜索表单（SearchTab 用 useSyncExternalStore，不再持有本地副本）。 */
export function subscribeSearchForm(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSearchForm(): SearchForm {
  return form;
}

export function setSearchForm(patch: Partial<SearchForm>): void {
  form = { ...form, ...patch };
  emit();
}

/**
 * 切工作区时清掉属于旧工作区的搜索态。
 *
 * 结果里存的是相对路径，换 root 后点命中只会被白名单拒掉；替换汇总更危险——
 * 确认框会拿旧工作区的改动面骗人，实际写的是新工作区的文件。查询词与选项保留：
 * 换工作区后往往是想用同样的词再搜一遍，清了反而要重打。
 */
export function resetSearchForm(): void {
  // 顶掉还在路上的搜索请求：它们回来时 mine !== currentSearchSeq()，不会把旧
  // 工作区的结果写回来（它们的 finally 也不会动 running，所以在这里一并清）。
  // replacing 不清：那次全量写盘还在跑，它的完成回调会自己把状态收尾。
  void nextSearchSeq();
  scrollTop = 0;
  form = {
    ...form,
    outcome: null,
    projectOutcome: null,
    outcomeRoot: null,
    outcomeOptions: null,
    collapsed: [],
    error: null,
    running: false,
    replaceOutcome: null,
  };
  emit();
}

/**
 * 搜索请求序号（模块级，不随组件卸载重置）。
 *
 * 慢请求回来时用它判断「这份结果是不是最新那次要的」。放在组件 ref 里的话，
 * 切页重挂载会从 0 重新数，上一轮还在路上的请求反而成了「最新」。
 */
let seq = 0;
export const nextSearchSeq = () => ++seq;
export const currentSearchSeq = () => seq;

// ── 搜索词历史（Eclipse / VS Code 的下拉历史，翻回上次搜的词是真实高频动作）──
const HISTORY_KEY = "ncforge.search.history";
const HISTORY_MAX = 10;

export function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    // 存储被禁用或内容损坏都不该让搜索页挂掉
    return [];
  }
}

/** 把 `query` 放到历史最前（去重），返回新历史。 */
export function pushHistory(query: string): string[] {
  const q = query.trim();
  if (!q) return loadHistory();
  const next = [q, ...loadHistory().filter((x) => x !== q)].slice(0, HISTORY_MAX);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* 配额或隐私模式下忽略 */
  }
  return next;
}
