import { invoke } from "./tauri";

/**
 * 补丁打包（M7）的命令封装与纯函数。
 *
 * 规则全部在后端（`patch_view.rs` 是从 `build-nc-patch.sh` 逐条落下来的），
 * 这里只做三件事：把 DTO 说清楚、把「这一项会打成什么样」算成界面能直接显示的字段、
 * 以及把出包参数拼成后端要的形状。**任何落位判定都不要在前端重算**——
 * 两处各算一遍，迟早会出现「界面显示 hyext、包却落在标准层」。
 */

export type PatchSection = "public" | "private" | "client" | "upm" | "hotwebs";

/** 一个已编译产物（`.class`，含内部类）。 */
export interface PatchClass {
  name: string;
  path: string;
  /** 相对 `.java` 更新？false = 打进去的可能是旧行为。 */
  fresh: boolean;
}

export interface PatchLayer {
  hyext: boolean;
  /** 判定依据，直接显示：`hyext（默认模块 ic,不查 jar）`。 */
  why: string;
}

export interface PatchProblem {
  /** `error` 会阻止出包；`warn` 只提示。 */
  level: string;
  text: string;
}

export interface PatchItem {
  path: string;
  /** 相对工作副本根：`ic/private/nc/bs/.../X.java`。 */
  rel: string;
  label: string;
  module: string;
  section: PatchSection;
  pkgRel: string;
  /** zip 内目录（不含文件名）。 */
  target: string;
  layer: PatchLayer | null;
  classes: PatchClass[];
  problems: PatchProblem[];
  blocked: boolean;
  /** 实际用的产物根（相对工作副本根）。 */
  outRootUsed: string | null;
}

export interface PatchScan {
  root: string;
  items: PatchItem[];
  problems: PatchProblem[];
  outRoots: string[];
  javaCount: number;
  classCount: number;
  blockedCount: number;
}

export interface PatchDefaults {
  workspaceRoot: string | null;
  outDir: string | null;
  /**
   * 这个路径哪来的：
   * `config` 用户自己设过 / `nc-patch` 继承脚本缓存 / `detect` 首次使用自动找到 /
   * `suggest` 首次使用给的建议值（还不存在）/ `none` 连工作区都没开。
   */
  outDirSource: "config" | "nc-patch" | "detect" | "suggest" | "none";
  /** `outDir` 现在是否真实存在；`suggest` 必然为 false。 */
  outDirExists: boolean;
  outRoot: string | null;
  outRootCandidates: string[];
  ncHome: string | null;
  ncHomeModules: number;
}

export interface PatchBuildArgs {
  files: string[];
  outDir: string;
  /** 改动内容描述，就是补丁包文件名（`<描述>_<年月日>.zip`）。 */
  desc: string;
  note: string;
  sqls: string[];
  date: string;
  forceHyext?: string[];
  forceStd?: string[];
}

export interface PatchBuildResult {
  zipPath: string;
  entries: number;
  javaCount: number;
  classCount: number;
  backup: string | null;
  notes: string[];
}

export const patchDefaults = () => invoke<PatchDefaults>("patch_defaults");

export const patchScan = (files: string[], forceHyext: string[] = [], forceStd: string[] = []) =>
  invoke<PatchScan>("patch_scan", { files, forceHyext, forceStd });

export const patchBuild = (args: PatchBuildArgs) => invoke<PatchBuildResult>("patch_build", { args });

export const patchSetOutDir = (dir: string) => invoke<void>("patch_set_out_dir", { dir });

/** 传 null 清掉自定义产物根，回到自动探测。 */
export const patchSetOutRoot = (dir: string | null) => invoke<void>("patch_set_out_root", { dir });

export const patchReveal = (path: string) => invoke<void>("patch_reveal", { path });

// ───────────────────────── 纯函数 ─────────────────────────

/** 本机日期的 `YYYYMMDD`。文件名用的就是它，所以必须取本地时区而不是 UTC。 */
export function ymd(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * 预览补丁包名。与后端 `patch_view::zip_file_name` 同一套规则：
 * 九个非法字符换 `_`，空描述回落「补丁」。只用于界面显示，真正命名在出包时由后端做。
 */
export function previewZipName(desc: string, date: string = ymd()): string {
  const safe = desc.replace(/[/\\:*?"<>|]/g, "_").trim();
  return `${safe || "补丁"}_${date}.zip`;
}

const SECTION_TEXT: Record<PatchSection, string> = {
  public: "public 段",
  private: "private 段",
  client: "client 段",
  upm: "upm 文件",
  hotwebs: "网页",
};

export function sectionLabel(s: PatchSection): string {
  return SECTION_TEXT[s] ?? s;
}

/** 列表上那个小标签：`hyext` / `标准` / `upm` / `网页`。 */
export function layerText(item: PatchItem): string {
  if (item.section === "upm") return "upm";
  if (item.section === "hotwebs") return "网页";
  return item.layer?.hyext ? "hyext" : "标准";
}

export type PairKind = "ok" | "miss" | "old";

export interface PairState {
  kind: PairKind;
  text: string;
  /** 鼠标悬停解释「为什么打不进去」。 */
  title: string;
}

/**
 * 「配对状态」：class 在不在、比 java 新不新。
 *
 * 三种状态对应脚本的三条硬规则——没有 class 打进去是个空目录，class 比 java 旧
 * 打进去的是旧行为（装到服务器上「改了却没生效」，最难查）。
 */
export function pairState(item: PatchItem): PairState {
  if (item.section === "upm") {
    return { kind: "ok", text: "整文件", title: "upm 整文件替换，不需要编译产物" };
  }
  if (item.section === "hotwebs") {
    return { kind: "ok", text: "整文件", title: "网页文件整文件替换，不需要编译产物" };
  }
  const n = item.classes.length;
  if (n === 0) {
    return { kind: "miss", text: "未编译", title: "没找到 .class：先在 IDE 里编译这个模块，否则打进去是空目录" };
  }
  const stale = item.classes.filter((c) => !c.fresh);
  if (stale.length > 0) {
    return {
      kind: "old",
      text: "过期",
      title: `这些 class 比 .java 旧，打进去的是旧行为：${stale.map((c) => c.name).join("、")}`,
    };
  }
  return { kind: "ok", text: `${n} class`, title: item.classes.map((c) => c.name).join("\n") };
}

export interface PatchGroup {
  module: string;
  items: PatchItem[];
}

/** 按模块分组，保持后端给的顺序（后端按模块名排序，界面不再重排）。 */
export function groupByModule(items: PatchItem[]): PatchGroup[] {
  const out: PatchGroup[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last.module === it.module) last.items.push(it);
    else out.push({ module: it.module, items: [it] });
  }
  return out;
}

export type FilterKey = "all" | "picked" | "problem" | "other";

export interface FilterCounts {
  all: number;
  picked: number;
  problem: number;
  other: number;
}

export function countFilters(items: PatchItem[], picked: Set<string>): FilterCounts {
  let problem = 0;
  let other = 0;
  let on = 0;
  for (const it of items) {
    if (hasProblem(it)) problem += 1;
    else if (it.section === "hotwebs" || it.section === "upm") other += 1;
    if (picked.has(it.path)) on += 1;
  }
  return { all: items.length, picked: on, problem, other };
}

/** 有任何 problem（error 或 warn）都算「有问题」，界面要能一眼筛出来。 */
export function hasProblem(item: PatchItem): boolean {
  return item.problems.length > 0 || item.blocked;
}

/** 搜索 + chip 过滤。搜索匹配文件名与包路径两处，只输包名也能定位。 */
export function filterItems(
  items: PatchItem[],
  picked: Set<string>,
  keyword: string,
  filter: FilterKey,
): PatchItem[] {
  const kw = keyword.trim().toLowerCase();
  return items.filter((it) => {
    if (filter === "picked" && !picked.has(it.path)) return false;
    if (filter === "problem" && !hasProblem(it)) return false;
    if (filter === "other" && it.section !== "hotwebs" && it.section !== "upm") return false;
    if (!kw) return true;
    return it.label.toLowerCase().includes(kw) || it.pkgRel.toLowerCase().includes(kw);
  });
}

/** 可勾选的项（有 error 的不允许勾，勾了也打不进包）。 */
export function selectablePaths(items: PatchItem[]): string[] {
  return items.filter((it) => !it.blocked).map((it) => it.path);
}

export interface SelectionStats {
  picked: number;
  total: number;
  classes: number;
  blocked: number;
  /** 勾上了但打不进去的条数（未编译 / 过期）。 */
  risky: number;
  percent: number;
}

export function selectionStats(items: PatchItem[], picked: Set<string>): SelectionStats {
  let on = 0;
  let classes = 0;
  let blocked = 0;
  let risky = 0;
  for (const it of items) {
    if (it.blocked) blocked += 1;
    if (!picked.has(it.path)) continue;
    on += 1;
    classes += it.classes.length;
    if (pairState(it).kind !== "ok") risky += 1;
  }
  return {
    picked: on,
    total: items.length,
    classes,
    blocked,
    risky,
    percent: items.length === 0 ? 0 : Math.round((on / items.length) * 100),
  };
}

/** CHANGES.md 手写段的字段。顺序就是界面上从上到下的顺序，也是写进文件里的顺序。 */
export const DRAFT_FIELDS = ["功能说明", "问题现象", "原因", "修改点", "影响范围"] as const;

export type DraftField = (typeof DRAFT_FIELDS)[number];

export type MdDraft = Record<DraftField, string>;

export const EMPTY_DRAFT: MdDraft = {
  功能说明: "",
  问题现象: "",
  原因: "",
  修改点: "",
  影响范围: "",
};

/**
 * 把手写分节拼成后端要的 `note`（原样放 CHANGES.md 最前）。
 *
 * 全部为空时返回空串——后端会自己补一个 `# 补丁修改说明` 标题，界面上「留空」
 * 和「写了一个空标题」是两回事。
 */
export function composeNote(draft: MdDraft): string {
  const parts: string[] = [];
  for (const f of DRAFT_FIELDS) {
    const v = draft[f].trim();
    if (v) parts.push(`## ${f}\n\n${v}`);
  }
  return parts.join("\n\n");
}

/** 收尾的一行总结：`9 / 12 已勾 · 13 个 class`。 */
export function statsLine(s: SelectionStats): string {
  return `${s.picked} / ${s.total} 已勾 · ${s.classes} 个 class`;
}
