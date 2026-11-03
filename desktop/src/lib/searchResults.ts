import type { ProjectSearchHit, SearchHit } from "./search";
import type { SearchForm } from "./searchStore";

/** 结果行：当前范围没有工程归属；全部工程时由后端结果补上。 */
export type ResultHit = SearchHit & { project?: string; root?: string };

export interface ResultFileGroup {
  /** 跨工程的同名路径不能互相折叠，键里要带工程根。 */
  key: string;
  /** 所属工程（当前范围没有）。 */
  project?: string;
  projectRoot?: string;
  /** 相对工程根、`/` 分隔。 */
  path: string;
  hits: ResultHit[];
}

export interface SearchResultSummary {
  hits: number;
  filesMatched: number;
  filesScanned: number;
  elapsedMs: number;
  truncated: boolean;
  projects: number;
}

export interface SearchResultView {
  groups: ResultFileGroup[];
  summary: SearchResultSummary;
  /** 读取失败的工程（仅「全部工程」有）。 */
  errors: string[];
  /** 结果所属的工作区根（「当前」标记与打开路径都靠它）。 */
  outcomeRoot: string | null;
}

/** 把两种范围的结果整理成同一份展示模型。没有结果（还没搜 / 报错）返回 null。 */
export function buildResultView(form: SearchForm): SearchResultView | null {
  if (form.scope === "current") {
    const o = form.outcome;
    if (!o) return null;
    const map = new Map<string, ResultFileGroup>();
    for (const hit of o.hits) {
      const g = map.get(hit.path);
      if (g) g.hits.push(hit);
      else map.set(hit.path, { key: hit.path, path: hit.path, hits: [hit] });
    }
    return {
      groups: [...map.values()],
      summary: {
        hits: o.hits.length,
        filesMatched: o.filesMatched,
        filesScanned: o.filesScanned,
        elapsedMs: o.elapsedMs,
        truncated: o.truncated,
        projects: 1,
      },
      errors: [],
      outcomeRoot: form.outcomeRoot,
    };
  }

  const po = form.projectOutcome;
  if (!po) return null;
  const groups: ResultFileGroup[] = [];
  let hits = 0;
  let filesMatched = 0;
  let filesScanned = 0;
  let truncated = false;
  for (const p of po.projects) {
    hits += p.outcome.hits.length;
    filesMatched += p.outcome.filesMatched;
    filesScanned += p.outcome.filesScanned;
    truncated = truncated || p.outcome.truncated;
    const map = new Map<string, ResultFileGroup>();
    for (const hit of p.outcome.hits as ProjectSearchHit[]) {
      const key = `${p.root.toLowerCase()}\u0000${hit.path}`;
      const g = map.get(key);
      if (g) g.hits.push(hit);
      else
        map.set(key, {
          key,
          project: p.project,
          projectRoot: p.root,
          path: hit.path,
          hits: [hit],
        });
    }
    groups.push(...map.values());
  }
  return {
    groups,
    summary: {
      hits,
      filesMatched,
      filesScanned,
      elapsedMs: po.elapsedMs,
      truncated: truncated || po.truncated,
      projects: po.projects.length,
    },
    errors: po.errors,
    outcomeRoot: form.outcomeRoot,
  };
}

/** 一个工程的结果分组（「全部工程」结果区按工程分段）。 */
export interface ResultProjectSection {
  project: string;
  root: string;
  groups: ResultFileGroup[];
  hits: number;
}

/**
 * 把扁平的「文件组」切成工程段。组的顺序由后端工程顺序决定，同名工程不会相邻出现，
 * 所以按连续段切就够了，不需要 Map（Map 会打乱工程顺序）。
 */
export function groupByProject(groups: ResultFileGroup[]): ResultProjectSection[] {
  const out: ResultProjectSection[] = [];
  for (const g of groups) {
    if (!g.projectRoot) continue;
    const last = out[out.length - 1];
    if (last && last.root.toLowerCase() === g.projectRoot.toLowerCase()) {
      last.groups.push(g);
      last.hits += g.hits.length;
    } else {
      out.push({
        project: g.project ?? g.projectRoot,
        root: g.projectRoot,
        groups: [g],
        hits: g.hits.length,
      });
    }
  }
  return out;
}
