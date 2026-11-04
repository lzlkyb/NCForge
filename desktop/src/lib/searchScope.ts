// 搜索范围：全工程 / 当前工程 / 按业务组件。
//
// 「按组件」是 manifest 从标注变成**数据**的第二个用法（第一个是文件树的 BC 徽章）：
// 我们知道工程根下哪些目录是业务组件，就能把搜索范围直接收窄到某一个。
//
// 🔴 范围取的是**模块目录本身**（`newar/bill`），不是 manifest 里的 `src/public` 们：
// 1. 组件不只有 Java——`resources/*.xml`、`META-INF/*.xml` 也是组件的一部分，
//    按源码根收窄会让「搜单据模板怎么搜不到」变成一个反复出现的疑问；
// 2. `roots` 可能为空或过期（登记表是手写的），空范围会被后端理解成「整个工作区」，
//    那就成了静默错范围；模块目录在不在磁盘上一试便知；
// 3. 代价可以忽略：一个模块的资源目录只有几十个文件。
//
// 范围只负责「收窄入口」，结果里的路径仍相对工作区根（口径见 `search.rs::plan_scope`）。
import type { NcComponent } from "./ncManifest";
import type { SearchOptions } from "./search";
import type { SearchForm } from "./searchStore";

/** 选择列表的一项：`name` 是目录名（也是传给后端的范围），`label` 是给人看的名字。 */
export interface ComponentOption {
  name: string;
  /** 中文名；与目录名相同时为空串（`dispname=""` 的组件很多）。 */
  label: string;
}

/**
 * 可选组件列表。
 *
 * manifest 里同一个组件能登记两次（newar 的 `medpub`），按名字去重后保留先到的那份；
 * 排序按目录名——用户找的是目录，不是中文名。
 */
export function componentOptions(components: NcComponent[]): ComponentOption[] {
  const seen = new Map<string, ComponentOption>();
  for (const c of components) {
    const name = c.name.trim();
    const key = name.toLowerCase();
    if (!key || seen.has(key)) continue;
    const disp = c.dispname.trim();
    seen.set(key, { name, label: disp && disp !== name ? disp : "" });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 组件名 → 传给后端的范围目录（工作区相对、`/` 分隔）。
 *
 * 只做归一化：去掉首尾空白与分隔符、把反斜杠换成 `/`。名字里出现 `..` 或盘符时
 * 返回空数组——宁可让后端回落并说明，也不构造出一个能跳出工作区的范围。
 */
export function componentScopeDirs(component: string | null): string[] {
  const raw = (component ?? "").trim();
  if (!raw) return [];
  const rel = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!rel || rel.includes(":") || rel.split("/").some((seg) => seg === "..")) return [];
  return [rel];
}

/** 这个范围的结果是不是「单个工作区内」的（替换与编辑匹配只对这类开）。 */
export function isSingleScope(scope: string): boolean {
  return scope !== "all";
}

/**
 * 表单 → 后端选项。
 *
 * 搜索、「全部替换」、「编辑匹配」必须用**同一份**：后端的替换复用搜索的候选收集
 * 逻辑，条件差一个字，「搜到的」和「会被改的」就不是同一批文件。
 *
 * 两处口径转换都在这里：
 * - 正则模式下搜索词按原样传（`^\s+$` 的前后空格有意义），纯文本模式 trim；
 * - 正则模式下「整词」不生效（后端也忽略），想整词自己写 `\b`，与 IDEA 一致。
 */
export function toSearchOptions(f: SearchForm): SearchOptions {
  return {
    text: f.regex ? f.query : f.query.trim(),
    caseSensitive: f.caseSensitive,
    wholeWord: f.regex ? false : f.wholeWord,
    regex: f.regex,
    include: f.include.trim(),
    // 范围只在组件下才有值：它是「收窄入口」，不是新的根（见 `search.rs::plan_scope`）
    dirs: f.scope === "component" ? componentScopeDirs(f.component) : [],
  };
}

/**
 * 范围回落时的说明（后端把 `scope_fallback` 置真：请求的目录一个都不存在）。
 *
 * 必须说出来：用户点的是「组件」，实际搜的是整个工作区，结果里出现别的模块
 * 如果不解释就成了「搜索坏了」。
 */
export function fallbackNote(missing: string[]): string {
  const where = missing.length > 0 ? `（${missing.join("、")}）` : "";
  return `范围目录在磁盘上不存在${where}，这次按整个工作区搜索`;
}

/** 部分目录缺失时的说明（范围仍然生效，只是比预期窄）。 */
export function missingNote(missing: string[]): string {
  return `有 ${missing.length} 个范围目录不存在，已跳过：${missing.join("、")}`;
}
