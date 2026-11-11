/**
 * 改动色条的数据源：按路径缓存 SVN 基线，并向「装饰层」与「摘要条」广播。
 *
 * 两类订阅故意分开：
 * - `subscribeBaseline` 给 Monaco 装饰层，基线到位/刷新时重算；
 * - `subscribeSnapshot` 给 React 摘要条，重算结果变了才刷新。
 * 合成一个的话，装饰层 publishSnapshot 会再触发自己重算 → 无限循环。
 *
 * 两层基线：
 * - `baselines` 是 SVN BASE，只有 commit/update/revert 才变（`invalidateBaselines`）；
 * - `roundBaselines` 是选中「一轮」后从本地历史归档点取来的轮前原文，
 *   由 `reviewSession.selectRound` 推进来，切回 SVN 基线时清空。
 * `effective` 是二者合成后的稳定引用缓存：useSyncExternalStore 的 getSnapshot
 * 每次必须返回同一个对象，不能现算新对象。
 *
 * 目录不在版本控制下、或取 diff 失败一律静默不画，不弹错误——打开工作副本外的
 * 文件是常态，不是故障。
 */
import { svnDiff } from "./svn";
import { onExternalJavaChanged } from "./externalJavaChanges";
import { getSession } from "./workspaceSession";
import { EMPTY_CHANGED, type ChangedSnapshot } from "./changedLines";

export interface ChangedBaseline {
  path: string;
  baseText: string;
  eol: string;
  encoding: string;
  state: "loading" | "ok" | "missing";
  at: number;
  /** 展示口径：SVN 基线 / 本轮前（归档点）。 */
  label?: string;
}

/** 与快照同源的改动行文本，审查清单用它核对表引用。 */
export interface ChangedRow { line: number; text: string }

const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
const baselines = new Map<string, ChangedBaseline>();
const roundBaselines = new Map<string, string>();
let effective = new Map<string, ChangedBaseline>();
const snapshots = new Map<string, ChangedSnapshot>();
const changedRows = new Map<string, ChangedRow[]>();
const baseListeners = new Set<() => void>();
const snapListeners = new Set<() => void>();
const inflight = new Set<string>();
/** 基线代际号：每次 invalidate +1，飞行中的旧结果据此作废。 */
let baseGen = 0;

export function subscribeBaseline(cb: () => void): () => void {
  baseListeners.add(cb);
  return () => { baseListeners.delete(cb); };
}
export function subscribeSnapshot(cb: () => void): () => void {
  snapListeners.add(cb);
  return () => { snapListeners.delete(cb); };
}
function syncEffective(): void {
  const next = new Map<string, ChangedBaseline>();
  for (const [key, base] of baselines) {
    const round = roundBaselines.get(key);
    next.set(key, round === undefined
      ? { ...base, label: "SVN 基线" }
      : { ...base, baseText: round, label: "本轮前" });
  }
  effective = next;
}
const emitBase = () => { syncEffective(); baseListeners.forEach((l) => l()); };
const emitSnap = () => snapListeners.forEach((l) => l());

export function getBaseline(path: string | null | undefined): ChangedBaseline | undefined {
  return path ? baselines.get(norm(path)) : undefined;
}
/** 装饰层与摘要条一律用这份：有轮基线时改画「这一轮」，否则画 SVN BASE。 */
export function getEffectiveBaseline(path: string | null | undefined): ChangedBaseline | undefined {
  return path ? effective.get(norm(path)) : undefined;
}
export function getSnapshotFor(path: string | null | undefined): ChangedSnapshot {
  return path ? snapshots.get(norm(path)) ?? EMPTY_CHANGED : EMPTY_CHANGED;
}
export function getChangedRows(path: string | null | undefined): readonly ChangedRow[] {
  return path ? changedRows.get(norm(path)) ?? [] : [];
}
export function activeChangedPath(): string | null {
  return getSession().activePath;
}

function sameRows(a: readonly ChangedRow[] | undefined, b: readonly ChangedRow[] | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  return a.every((r, i) => r.line === b[i].line && r.text === b[i].text);
}

/** 装饰层算完把结果交回来；快照与改动行都没变就不广播。 */
export function publishSnapshot(
  path: string,
  snap: ChangedSnapshot,
  rows?: readonly ChangedRow[],
): void {
  const k = norm(path);
  const prevRows = changedRows.get(k);
  const rowsChanged = rows !== undefined && !sameRows(prevRows, rows);
  if (rows !== undefined) changedRows.set(k, [...rows]);
  if (snapshots.get(k) === snap && !rowsChanged) return;
  snapshots.set(k, snap);
  emitSnap();
}

/** 取基线。`force` 用于提交/更新后重取。同一路径并发只发一次。 */
export function requestBaseline(path: string, force = false): void {
  if (!path) return;
  const k = norm(path);
  if (inflight.has(k)) return;
  if (!force && baselines.has(k)) return;
  const gen = baseGen;
  inflight.add(k);
  baselines.set(k, { path, baseText: "", eol: "", encoding: "", state: "loading", at: Date.now() });
  emitBase();
  void svnDiff(path)
    .then((r) => {
      // 飞行途中被 invalidate（提交/更新）：这一批是旧 BASE。照样回填会让
      // 「已提交的内容」继续画成改动，还会占着缓存挡住重取——直接丢弃。
      if (gen !== baseGen) return;
      baselines.set(k, {
        path,
        baseText: r.baseText,
        eol: r.eol,
        encoding: r.encoding,
        state: "ok",
        at: Date.now(),
      });
    })
    .catch(() => {
      // 不在版本控制下 / 桥没起 / 口令没配：静默降级，代码面照常可用
      if (gen !== baseGen) return;
      baselines.set(k, { path, baseText: "", eol: "", encoding: "", state: "missing", at: Date.now() });
    })
    .finally(() => {
      inflight.delete(k);
      emitBase();
    });
}

/**
 * SVN 写操作（commit / update / revert / resolve）收尾调用：BASE 可能已经变了。
 * 只清缓存并广播，挂载着的编辑器会按需重取自己那一个文件——一次提交几十个
 * 文件不该一口气发几十个 svn_diff。
 */
export function invalidateBaselines(): void {
  // 代际号：在途的 svnDiff 回来后据此判断「我这份 BASE 已经作废」
  baseGen += 1;
  baselines.clear();
  // 快照与变更行也必须一起清：只清 baselines 的话，`getChangedRows` 会继续返回
  // 用**旧 BASE** 算出的行号与行文本，审查清单拿它去核对表名，核对的是已提交的内容。
  // 提交 / 更新 / 还原之后这些文件本来就没有本地改动了，清掉才是正确结果。
  snapshots.clear();
  changedRows.clear();
  emitBase();
  emitSnap();
}

/** 保留兼容：单路径强制重取。还原本轮后 BASE 没变，不该调这个。 */
export function refreshBaseline(path: string): void {
  baselines.delete(norm(path));
  requestBaseline(path, true);
}

/** 让当前所有装饰层重算（保存、外部写入、轮基线切换后内容变了，但 BASE 没变）。 */
export function recomputeChanged(): void {
  emitBase();
}

/** 选中一轮 / 切回 SVN 基线：推进轮前原文并触发全体重算。 */
export function setRoundBaselines(texts: Map<string, string>): void {
  roundBaselines.clear();
  for (const [path, text] of texts) roundBaselines.set(norm(path), text);
  emitBase();
}

let started = false;
/** 幂等接线，由 `attachChangedLines` 调用一次。 */
export function initChangedLines(): void {
  if (started) return;
  started = true;
  onExternalJavaChanged(() => recomputeChanged());
}

/** 单测/换工作区用：清空缓存。 */
export function resetChangedLines(): void {
  baselines.clear();
  roundBaselines.clear();
  effective.clear();
  snapshots.clear();
  changedRows.clear();
  inflight.clear();
}

/**
 * 「上一处 / 下一处」的实际跳转由 Monaco 装饰层注册到这里。
 * 摘要条是纯 React 组件，不该为了两个按钮把 monaco-editor 拖进组件测试。
 */
let jumpHandler: ((step: number) => void) | null = null;
export function setChangedJumpHandler(fn: (step: number) => void): void {
  jumpHandler = fn;
}
export function jumpChanged(step: number): void {
  jumpHandler?.(step);
}
