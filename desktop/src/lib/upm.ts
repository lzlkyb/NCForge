import { invoke } from "./tauri";
import { trackOperation } from "./operations";

/**
 * NC 组件装配表（`META-INF/*.upm`）的查询。
 *
 * 真源在 Rust `nc_upm`：接口 → 实现是**运行时** lookup 的唯一依据，编译器不管。
 * 这里只做类型对齐与两件事：拿全量诊断、按类名查装配。
 */

/** 诊断种类，与 Rust `nc_upm::IssueKind` 的 serde 值一一对应。 */
export type UpmIssueKind =
  | "missing-impl"
  | "missing-interface"
  | "duplicate-impl"
  | "module-mismatch";

export interface UpmIssue {
  kind: UpmIssueKind;
  severity: "error" | "warning";
  module: string;
  /** 出问题的 upm 文件；`duplicate-impl` 时是多份文件用 ` | ` 连接 */
  path: string;
  /** 相关的类名；`module-mismatch` 为空 */
  className: string;
  detail: string;
}

export interface UpmStats {
  files: number;
  projectFiles: number;
  productFiles: number;
  components: number;
  interfaces: number;
  modules: number;
}

export interface UpmReport {
  stats: UpmStats;
  issues: UpmIssue[];
  /** 解析过程中的提示（空 upm、读不动），不是错误 */
  notes: string[];
  /**
   * 类存在性是否做了完整判定。
   * `false` = 没有类索引，`missing-*` 两类没跑（不能当成「没问题」）。
   */
  classCheckComplete: boolean;
}

export interface UpmHit {
  interface: string;
  implementation: string;
  module: string;
  path: string;
  origin: "project" | "product";
  visibility: string;
  remote: boolean;
  tx: string;
  singleton: boolean;
  /** `interface` = 输入的是接口名；`implementation` = 输入的是实现类名 */
  matchedBy: "interface" | "implementation";
}

export const UPM_ISSUE_LABEL: Record<UpmIssueKind, string> = {
  "missing-impl": "实现类缺失",
  "missing-interface": "接口缺失",
  "duplicate-impl": "多处装配",
  "module-mismatch": "模块名不符",
};

/**
 * 跑一次装配索引 + 诊断。
 *
 * `deep = true` 会建/用 jar 类索引（首次 10~100 秒，之后有缓存），才能判定
 * 「实现类根本不存在」；默认只查工程源码与散类，缺失类一律不下结论。
 * `refresh = true` 强制重扫（保存了 upm 之后用）。
 */
export function upmIndex(opts: {
  root?: string | null;
  deep?: boolean;
  refresh?: boolean;
}): Promise<UpmReport> {
  return invoke<UpmReport>("nc_upm_index", {
    root: opts.root ?? null,
    deep: opts.deep ?? false,
    refresh: opts.refresh ?? false,
  });
}

/** 按类名查装配：接口名查实现，实现类名查它被谁装配。 */
export function upmLookup(query: string, root?: string | null): Promise<UpmHit[]> {
  return trackOperation({ key: `upm.lookup:${root}:${query}`, label: "查找 UPM 装配", scope: root ?? "工作区", page: "linked", phase: "按类名读取装配注册" }, () => invoke<UpmHit[]>("nc_upm_lookup", { query, root: root ?? null }));
}

/** 装配表格里那一列「实现 / 修饰」的短描述。 */
export function upmEntryLabel(hit: UpmHit): string {
  const bits: string[] = [];
  bits.push(hit.visibility === "private" ? "private" : "public");
  if (hit.remote) bits.push("remote");
  if (hit.tx) bits.push(hit.tx);
  if (hit.singleton) bits.push("singleton");
  return bits.join(" · ");
}
