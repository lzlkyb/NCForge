/**
 * 编辑器视图快照：光标、选区、滚动位置，跨重启恢复。
 *
 * 🔴 为什么只存「恢复所需的最小集合」而不存整份 `saveViewState()`：
 * 整份里最占地方的是 `contributionsState`（折叠区），而折叠区号是**视图行号**，
 * 文件一旦改动就会指到别处——恢复出来是一堆莫名其妙的折叠。宁可少恢复一样，
 * 也不要造出用户没做过的动作。`contributionsState` 恢复成 `{}` 即「全部展开」。
 *
 * 🔴 为什么不用 `scrollTop` 而用 `firstPosition`：
 * Monaco 的 `reduceRestoreState` 分两支——有 `firstPosition` 时按「视口首行的模型位置」
 * 反算滚动偏移（文件行数变了会自动夹住），没有时走老格式兼容分支读
 * `scrollTopWithoutViewZones`。给一个不带 `firstPosition`、只带 `scrollTop` 的对象，
 * 取到的是 `undefined`，界面直接滚回顶部。所以：**`firstPosition` 不在就别存**。
 */
const KEY = "ncforge-editor-views";
/** 字节预算。一个文件的快照约 300 字节，64 KiB 够两百个文件；超了按最旧淘汰。 */
const BUDGET_BYTES = 64 * 1024;
const WRITE_DELAY_MS = 1500;

export interface ViewPosition {
  lineNumber: number;
  column: number;
}

/** 与 `monaco.editor.ICursorState[]` 同构（含多光标），不直接依赖 Monaco 类型以便单测。 */
export type CursorState = {
  inSelectionMode: boolean;
  selectionStart: ViewPosition;
  position: ViewPosition;
}[];

/** 与 `monaco.editor.IViewState` 同构，只保留恢复真正会用到的三项。 */
export interface PersistedViewState {
  scrollLeft: number;
  firstPosition: ViewPosition;
  firstPositionDeltaTop: number;
}

export interface ViewSnapshot {
  cursorState: CursorState;
  viewState: PersistedViewState;
  /** 写入时刻，只用于淘汰排序，不参与恢复。 */
  at: number;
}

/** 可直接喂给 `editor.restoreViewState()` 的结构（同构于 `ICodeEditorViewState`）。 */
export interface RestorableView {
  cursorState: CursorState;
  viewState: PersistedViewState;
  contributionsState: Record<string, never>;
}

const ENCODER = new TextEncoder();
const cache = new Map<string, ViewSnapshot>();
let loaded = false;
let dirty = false;
let writeTimer: number | undefined;
let hooked = false;

const keyOf = (path: string) => path.toLowerCase();

function isPos(v: unknown): v is ViewPosition {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.lineNumber === "number" && Number.isFinite(p.lineNumber) && p.lineNumber >= 1 &&
    typeof p.column === "number" && Number.isFinite(p.column) && p.column >= 1
  );
}

function isCursor(v: unknown): v is CursorState[number] {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return typeof c.inSelectionMode === "boolean" && isPos(c.selectionStart) && isPos(c.position);
}

/**
 * 裁出可恢复的最小集合；拿不到 `firstPosition` 就返回 null。
 *
 * 返回 null 的语义是「这个快照不可信，别恢复」——宁可让用户落在第一行，
 * 也不要把光标扔到一个错的位置，那样用户会以为文件被改过。
 */
export function trimViewState(state: unknown): Omit<ViewSnapshot, "at"> | null {
  if (!state || typeof state !== "object") return null;
  const s = state as Record<string, unknown>;
  const view = s.viewState;
  if (!view || typeof view !== "object") return null;
  const v = view as Record<string, unknown>;
  if (!isPos(v.firstPosition)) return null;
  const delta = typeof v.firstPositionDeltaTop === "number" && Number.isFinite(v.firstPositionDeltaTop)
    ? v.firstPositionDeltaTop
    : 0;
  const scrollLeft = typeof v.scrollLeft === "number" && Number.isFinite(v.scrollLeft) ? v.scrollLeft : 0;
  // 多光标：保留顺序，遇到畸形项就丢这一项（丢项不影响主光标是第 0 项）
  const cursors = Array.isArray(s.cursorState) ? s.cursorState.filter(isCursor) : [];
  if (cursors.length === 0) return null;
  return {
    cursorState: cursors,
    viewState: { scrollLeft, firstPosition: v.firstPosition, firstPositionDeltaTop: delta },
  };
}

export function toRestorableView(snap: ViewSnapshot | Omit<ViewSnapshot, "at">): RestorableView {
  return {
    cursorState: snap.cursorState,
    viewState: snap.viewState,
    // 折叠状态刻意不恢复：见文件头
    contributionsState: {},
  };
}

function load(): Map<string, ViewSnapshot> {
  if (loaded) return cache;
  loaded = true;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return cache;
    for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
      const trimmed = trimViewState(value);
      if (!trimmed) continue;
      const at = (value as { at?: unknown }).at;
      cache.set(path, { ...trimmed, at: typeof at === "number" ? at : 0 });
    }
  } catch {
    /* 写坏了当作没有：视图位置丢了一无损失 */
  }
  return cache;
}

/** 读某个文件的视图快照；没有就返回 null（调用方保持 Monaco 默认行为）。 */
export function readEditorView(path: string): ViewSnapshot | null {
  load();
  return cache.get(keyOf(path)) ?? null;
}

/**
 * 恢复时该用哪份视图：先看内存（同一次运行里切回来），没有再退到磁盘（进程重启后）。
 *
 * 抽成纯函数是为了能被单测钉住——`EditorPane` 里这段只有一行，但它是「重启无痛」
 * 唯一的新增语义，删掉不会让任何类型检查变红，只会让恢复悄悄退回行 1。
 */
export function pickRestoreView(cached: unknown, path: string): unknown {
  if (cached) return cached;
  const snap = readEditorView(path);
  return snap ? toRestorableView(snap) : null;
}

/** 字节数按 UTF-8 算（localStorage 配额按字节，不是字符数）。 */
function costOf([path, snap]: [string, ViewSnapshot]): number {
  // `"path":{...},` —— 4 是引号、冒号与逗号的固定开销
  return ENCODER.encode(path).length + ENCODER.encode(JSON.stringify(snap)).length + 4;
}

/**
 * 写盘：超预算时**从最旧的开始淘汰**，而不是整份丢弃。
 *
 * 整份丢弃的代价是「打开一个新文件就把所有位置都忘了」——用户感知不到规则，
 * 只会觉得恢复时灵时不灵。
 */
function persist(): void {
  const entries = [...cache.entries()];
  if (entries.length === 0) {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* 忽略 */
    }
    return;
  }
  // 新 → 旧 累加，装不下的都是更旧的
  const byAge = [...entries].sort((a, b) => b[1].at - a[1].at);
  const kept: [string, ViewSnapshot][] = [];
  let bytes = 2; // {}
  for (const entry of byAge) {
    const cost = costOf(entry) - 2; // 扣掉单独序列化时多出来的那对花括号
    if (kept.length > 0 && bytes + cost > BUDGET_BYTES) break;
    kept.push(entry);
    bytes += cost;
  }
  const keptKeys = new Set(kept.map(([p]) => p));
  for (const path of [...cache.keys()]) {
    if (!keptKeys.has(path)) cache.delete(path);
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // 配额满（别的模块把 localStorage 占满了）：砍掉一半最旧的再试一次，
    // 仍失败就放弃这一轮。不抛错——保存视图位置失败不该影响任何功能。
    for (const [path] of kept.slice(Math.floor(kept.length / 2))) cache.delete(path);
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(cache)));
    } catch {
      /* 放弃 */
    }
  }
}

export function flushEditorViews(): void {
  if (writeTimer !== undefined) {
    window.clearTimeout(writeTimer);
    writeTimer = undefined;
  }
  if (!dirty) return;
  dirty = false;
  persist();
}

function scheduleWrite(): void {
  if (!hooked && typeof window !== "undefined") {
    hooked = true;
    // 进程被强杀时定时器不一定还有机会跑，补一次同步写（与 `dbHistory` 同口径）。
    window.addEventListener("pagehide", flushEditorViews);
  }
  if (writeTimer !== undefined) return;
  writeTimer = window.setTimeout(() => {
    writeTimer = undefined;
    flushEditorViews();
  }, WRITE_DELAY_MS);
}

/** 记一条视图快照（只进内存 + 排一次写盘）。 */
export function rememberEditorView(path: string, state: unknown): void {
  const trimmed = trimViewState(state);
  if (!trimmed) return;
  load();
  const id = keyOf(path);
  const prev = cache.get(id);
  // 位置没变就不算改动：滚动时每帧都会回调，不变也写会白白拖慢打字
  if (prev && JSON.stringify(prev.viewState) === JSON.stringify(trimmed.viewState)
      && JSON.stringify(prev.cursorState) === JSON.stringify(trimmed.cursorState)) return;
  cache.set(id, { ...trimmed, at: Date.now() });
  dirty = true;
  scheduleWrite();
}

/**
 * 节流上报器。滚动时 `onDidScrollChange` 每帧都回调，直接每次 `saveViewState()`
 * 会把主线程拖进无谓的计算；这里按 `minIntervalMs` 取一次，并保证最后一次一定落。
 */
export function createViewReporter(minIntervalMs = 300) {
  let last = 0;
  let timer: number | undefined;
  return {
    report(path: string | null, getState: () => unknown): void {
      if (!path) return;
      const now = Date.now();
      const fire = () => {
        timer = undefined;
        last = Date.now();
        rememberEditorView(path, getState());
      };
      if (now - last >= minIntervalMs) {
        if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
        fire();
        return;
      }
      if (timer === undefined) timer = window.setTimeout(fire, minIntervalMs);
    },
    /** 卸载 / 切文件时立即落一次，别让最后一段移动停在内存里。 */
    flush(path: string | null, getState: () => unknown): void {
      if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
      if (path) rememberEditorView(path, getState());
    },
    dispose(): void {
      if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
    },
  };
}

/** 测试专用：清内存缓存，模拟「进程重启」。 */
export function __resetEditorViewsForTest(): void {
  cache.clear();
  loaded = false;
  dirty = false;
  if (writeTimer !== undefined) { window.clearTimeout(writeTimer); writeTimer = undefined; }
}
