import { invoke } from "./tauri";
import type { CompileDiagnostic } from "./compile";

/**
 * 「工程关联」弹框的数据与操作。
 *
 * 与 Rust `eclipse_cp::{LinkedGraph,LinkedProject}` 一一对应（camelCase）。
 * 依赖顺序的真源是工程自己的 `.classpath`；这里只是把它解析出来给人看，
 * 覆盖表（disable / front / add）是「不改 Eclipse 配置也能验证」的旋钮。
 */

/** 工程在依赖链里的来路，决定界面上那枚标签的含义。 */
export type ProjectOrigin = "primary" | "classpath" | "legacy" | "front";

export interface LinkedProject {
  name: string;
  /** 工程根；null = `.classpath` 里写了但磁盘上找不到 */
  root: string | null;
  origin: ProjectOrigin;
  /** 0 = 主工程；越大表示离主工程越远 */
  depth: number;
  /** 由上一级引入时那条边是否 `exported="true"`（决定它会不会继续往下传递） */
  exported: boolean;
  classDirs: string[];
  /** 被覆盖表停用：条目还在（看得见自己停用了谁），但目录不参与类路径 */
  disabled: boolean;
  /** 是否读到了 `.classpath`（false = 走老启发式扫目录） */
  hasClasspath: boolean;
}

export interface LinkedGraph {
  primary: string;
  primaryRoot: string;
  workspace: string;
  projects: LinkedProject[];
  extraDirs: string[];
  projectDirCount: number;
  ncHomeDirCount: number;
  totalDirCount: number;
  /** 解析中的异常与覆盖动作，直接显示在页面上 */
  notes: string[];
}

export type OverrideAction = "disable" | "front" | "add";

export interface LinkedOverride {
  action: OverrideAction;
  target: string;
  dir?: string | null;
}

export const originLabel = (o: ProjectOrigin): string => {
  switch (o) {
    case "primary":
      return "主工程";
    case "classpath":
      return "依赖";
    case "legacy":
      return "无 .classpath";
    case "front":
      return "已提前";
    default:
      return o;
  }
};

export const actionLabel = (a: OverrideAction): string => {
  switch (a) {
    case "disable":
      return "停用";
    case "front":
      return "排前";
    case "add":
      return "追加目录";
    default:
      return a;
  }
};

/** 读依赖链。`root` 传了就先看那个工程（用于切换工作区之前的预演）。 */
export const linkedProjects = (root?: string) =>
  invoke<LinkedGraph>("linked_projects", { root: root ?? null });

/** 全量替换覆盖表；返回落盘后的列表（以服务端为准，避免本地状态漂移）。 */
export const setLinkedOverrides = (overrides: LinkedOverride[]) =>
  invoke<LinkedOverride[]>("set_linked_overrides", { overrides });

/**
 * 检查各工程的产物是否比源码旧（D4 的全量版本）。
 *
 * 🔴 **按需调用**，别挂到编译流程里：真机实测三工程 `C:\work\aier` 要 8~22 秒
 * （12k 个 .java / 13k 个 .class / 149k 个目录条目，本机目录枚举约 7~15k 条目/秒）。
 * 编译流程内只有**按类**判断（毫秒级），见 `CompileResult.diagnostics`。
 */
export const checkArtifacts = (root?: string) =>
  invoke<CompileDiagnostic[]>("check_artifacts", { root: root ?? null });

/**
 * 一条覆盖是否真的命中了某个工程。
 *
 * 后端匹配的是「工程名 / 目录名 / 绝对路径」三路，这里保持一致——界面对不上号时
 * 用户会以为「我明明加了却没生效」。**不要**改成只比 `name`。
 */
export function overrideHits(o: LinkedOverride, p: LinkedProject): boolean {
  const t = o.target.trim().toLowerCase();
  if (!t) return false;
  if (p.name.toLowerCase() === t) return true;
  if (!p.root) return false;
  const root = p.root.replace(/\\/g, "/").toLowerCase();
  if (root === t.replace(/\\/g, "/")) return true;
  const base = root.split("/").filter(Boolean).pop() ?? "";
  return base === t;
}

/** 某个工程身上生效的覆盖（用于按钮高亮与「为什么它排在这里」的解释）。 */
export function activeOverridesOf(
  overrides: LinkedOverride[],
  p: LinkedProject,
): LinkedOverride[] {
  return overrides.filter((o) => o.action !== "add" && overrideHits(o, p));
}

// ── 覆盖表的草稿运算 ──────────────────────────────────────────────
//
// 后端 `set_linked_overrides` 是**全量替换**，所以界面只能「整表草稿 + 一次保存」：
// 单条即时保存会把用户刚加的另一条无声冲掉。下面这组函数就是这份草稿的读写口径，
// 统一放在 lib 里而不是散在组件中——「同一条」的判定必须只有一处，否则按钮高亮的
// 和列表里去重的会各说一套。

/** 规范化：动作小写、目标去首尾空白、`dir` 只在 `add` 下有值。 */
export function normalizeOverride(o: LinkedOverride): LinkedOverride {
  const action = String(o.action ?? "").trim().toLowerCase() as OverrideAction;
  const dir = String(o.dir ?? "").trim();
  return {
    action,
    target: String(o.target ?? "").trim(),
    dir: action === "add" && dir ? dir : null,
  };
}

/**
 * 一条覆盖的身份键：同动作 + 同目标 = 同一条。
 *
 * `add` 按目录区分——追加两个目录本来就是两条。比较忽略大小写与首尾空白，与后端
 * `overrideHits` 的匹配口径一致（Windows 路径不分大小写）。
 */
export function overrideKey(o: LinkedOverride): string {
  const n = normalizeOverride(o);
  const t = n.target.toLowerCase();
  return n.action === "add" ? `add|${t}|${(n.dir ?? "").toLowerCase()}` : `${n.action}|${t}`;
}

/** 草稿里是否已有同一条（按钮据此显示「取消停用 / 取消排前」）。 */
export function hasOverride(list: LinkedOverride[], o: LinkedOverride): boolean {
  const k = overrideKey(o);
  return list.some((x) => overrideKey(x) === k);
}

/** 原位替换同一条，没有就追加。**不**叠两条同动作同目标的项：后端会两条都生效，行为难解释。 */
export function upsertOverride(list: LinkedOverride[], o: LinkedOverride): LinkedOverride[] {
  const next = normalizeOverride(o);
  const k = overrideKey(next);
  let replaced = false;
  const out = list.map((x) => {
    if (overrideKey(x) !== k) return x;
    replaced = true;
    return next;
  });
  return replaced ? out : [...out, next];
}

/** 从草稿里删掉同一条（全部匹配项，防止手写配置里本来就有重复）。 */
export function removeOverride(list: LinkedOverride[], o: LinkedOverride): LinkedOverride[] {
  const k = overrideKey(o);
  return list.filter((x) => overrideKey(x) !== k);
}

/**
 * 两份覆盖表是否等价。
 *
 * **顺序也算改动**：保存是全量替换，落盘顺序变了就是配置变了（`front` 的先后会
 * 影响类路径顺序，而顺序即行为）。所以这里按位置逐条比，不排序。
 */
export function sameOverrides(a: LinkedOverride[], b: LinkedOverride[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => overrideKey(x) === overrideKey(b[i]));
}

/** 配置里存回来的条目 → 草稿（`dir` 的 `undefined` / `null` 统一成 null）。 */
export function toDraft(list: LinkedOverride[] | null | undefined): LinkedOverride[] {
  return (list ?? []).map(normalizeOverride);
}
