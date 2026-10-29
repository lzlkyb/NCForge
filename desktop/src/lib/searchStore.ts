import type { SearchOutcome } from "./search";

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
  outcome: SearchOutcome | null;
  /**
   * 这份结果是在哪个工作区下搜出来的。
   *
   * 结果里存的是相对路径，点命中时要用**当前** root 拼绝对路径。换过工作区还留着
   * 旧结果的话，点一下就是拿旧相对路径拼新 root，被白名单拒掉、弹一串英文错误。
   */
  outcomeRoot: string | null;
  /**
   * 搜索在跑。放仓库里（而不是组件 state）：切页会卸载组件，loading 归 false，
   * 而后端那次全盘扫描还在跑——回来再点一次就是两个扫描并行。
   */
  running: boolean;
  /** 折叠起来的文件路径。 */
  collapsed: string[];
  /** 上次滚动位置，回来时恢复。 */
  scrollTop: number;
  /** 后端报错（多半是正则语法错）。 */
  error: string | null;
}

const EMPTY: SearchForm = {
  query: "",
  include: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  outcome: null,
  outcomeRoot: null,
  running: false,
  collapsed: [],
  scrollTop: 0,
  error: null,
};

let form: SearchForm = { ...EMPTY };

export function getSearchForm(): SearchForm {
  return form;
}

export function setSearchForm(patch: Partial<SearchForm>): void {
  form = { ...form, ...patch };
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
