import { invoke } from "./tauri";

/**
 * 工程根的 `manifest.xml`（NC 的业务组件登记表）。
 *
 * **它不是树的真源**：`newar` 磁盘上有 59 个带 `src/` 的模块目录，manifest 只登记 32 个，
 * 同一个名字还能登记两次。所以这里只做一件事——告诉树「这个模块是业务组件」，
 * 绝不能拿它决定树里显示什么。
 */
export interface NcComponent {
  name: string;
  dispname: string;
  /** `src/public` 这类源码根，顺序按 manifest。 */
  roots: string[];
}

export interface NcManifest {
  components: NcComponent[];
  /** 解析异常（同名重复、缺 name），本界面不展示，留给排查。 */
  notes: string[];
}

/**
 * 登记缺口（`nc_manifest_audit`）：磁盘上有模块目录、登记表里没有的那些。
 *
 * 只用来解释「为什么 `aim` 不在组件范围里」，不是错误清单——登记表由 NC 设计器维护，
 * 平台/工具模块本来就不会在里面。`unregistered` 为空时不显示那行提示。
 */
export interface ManifestAudit {
  /** 登记表里有效（去重、非空）的组件名个数。 */
  registered: number;
  /** 磁盘上像模块的目录个数（有 `src` 或 `.classpath`）。 */
  onDisk: number;
  unregistered: string[];
}

/** 小写组件名 → 徽章提示里的名字。空 Map = 没有 manifest / 读失败。 */
export type ComponentIndex = Map<string, string>;

/** 共享的空索引：`useState(EMPTY_INDEX)` 的初值必须引用稳定，否则每次渲染都换新值。 */
export const EMPTY_INDEX: ComponentIndex = new Map();

/**
 * 把清单压成徽章索引。
 *
 * 键统一小写：Windows 目录名不区分大小写，manifest 写 `Bill`、磁盘上是 `bill` 也得认。
 * 显示名跟目录名一样时不重复记（`dispname=""` 的组件很多）。
 */
export function componentIndex(components: NcComponent[]): ComponentIndex {
  const out: ComponentIndex = new Map();
  for (const c of components) {
    const name = c.name.trim();
    const key = name.toLowerCase();
    if (!key || out.has(key)) continue;
    const disp = c.dispname.trim();
    out.set(key, disp && disp !== name ? disp : name);
  }
  return out;
}

/**
 * 目录行该不该打徽章。只按名字比：manifest 不写路径，树里的模块目录就是工程根下那一层。
 */
export function bcBadge(dirName: string, index: ComponentIndex): string | undefined {
  if (!index.size) return undefined;
  return index.get(dirName.trim().toLowerCase());
}

/**
 * 多工程树：各工程的索引合成一份。同名保留先到的（`roots[0]` 是当前工作区）。
 * 合并只影响「同名的两个模块各自属于哪个工程」，对徽章本身没有影响。
 */
export function mergeIndexes(all: ComponentIndex[]): ComponentIndex {
  if (all.length === 0) return EMPTY_INDEX;
  if (all.length === 1) return all[0];
  const merged: ComponentIndex = new Map();
  for (const m of all) for (const [k, v] of m) if (!merged.has(k)) merged.set(k, v);
  return merged;
}

/**
 * 取某个工程根的清单（**原样**：含 roots，供按组件搜索定位目录）。
 *
 * 读不到 / 格式坏都返回空清单——manifest 只是标注与范围快捷方式，
 * 出错不该弹 toast，更不该挡住文件树与搜索。
 */
export async function loadNcComponents(root: string): Promise<NcComponent[]> {
  try {
    const m = await invoke<NcManifest>("nc_manifest", { root });
    return m.components ?? [];
  } catch {
    return [];
  }
}

/**
 * 取某个工程根的清单并压成徽章索引。读不到就是空索引。
 *
 * 空清单回共享的 `EMPTY_INDEX` 而不是新建 Map：徽章索引会进 `useState`，
 * 每次都给新引用会让 `useNcComponents` 的消费者白重渲染一轮。
 */
export async function loadNcManifest(root: string): Promise<ComponentIndex> {
  const list = await loadNcComponents(root);
  return list.length === 0 ? EMPTY_INDEX : componentIndex(list);
}

/**
 * 取某个工程根的登记缺口。读不到 manifest 就返回 `null`（界面不显示那行提示）——
 * 没有登记表时「未登记」这个词没有意义，列出全部模块只会变成噪声。
 */
export async function loadManifestAudit(root: string): Promise<ManifestAudit | null> {
  try {
    const a = await invoke<ManifestAudit>("nc_manifest_audit", { root });
    return { ...a, unregistered: a.unregistered ?? [] };
  } catch {
    return null;
  }
}
