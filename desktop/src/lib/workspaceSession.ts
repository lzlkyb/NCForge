import { useCallback, useRef, useSyncExternalStore } from "react";
import type { PanelTab } from "../components/workspace/BottomPanel";
import type { BuildProgress, CompileResult } from "./compile";
import { onDirtyChange } from "./dirtyBus";
import type { DirItem, EncodingMark, Eol, TextEncoding } from "./workspace";
import { reconcileEditorGroups, type EditorGroups, type EditorGroupId } from "./editorGroups";

/** 单个目录的加载结果：加载中 / 条目 / 错误信息。 */
export type TreeDirState =
  | { status: "loading" }
  | { status: "ok"; items: DirItem[] }
  | { status: "error"; message: string };

/**
 * 文件树的展开态与已加载目录。
 *
 * 一起放这里的原因和标签页相同：切页会卸载整棵子树。只是「标签还在、树塌回去」
 * 也很割裂——点了搜索结果跳回来，还要重新一层层点开。缓存按 root 归属，
 * 换工作区时由 FileTree 重置。
 */
export interface TreeState {
  root: string | null;
  expanded: Set<string>;
  dirs: Record<string, TreeDirState>;
  /**
   * 编码标记（键 = 完整路径）。跟树缓存在一起：读一次就够，切页回来不重扫，
   * 也不会因为重新挂载而让标记闪一下才出现。
   */
  marks: Record<string, EncodingMark>;
}

/**
 * 文件页的会话态（模块级，不随组件卸载消失）。
 *
 * 页面是按 tab 切的，`ErrorBoundary key={activeTab}` 一换 tab 就整棵子树卸载，
 * 组件里的 useState 全丢。文件正文之所以没丢，是因为 Monaco model 本来就存在
 * `lib/editorStore`；可标签列表还在组件里，于是「打开几个文件 → 去搜索页 →
 * 点结果跳回来」时标签栏会空掉（model 还在，只是没入口了），编译结果同样消失。
 *
 * 所以把这几项搬出来。这里只放数据，不算视图状态（光标位置由 Monaco 的
 * viewState 负责，滚动位置同理）。
 */
export interface TabMeta {
  /** 长期钉住，与预览标签转正分别表达。 */
  pinned?: boolean;
  previewGroup?: EditorGroupId;
  path: string;
  name: string;
  encoding: TextEncoding;
  hasBom: boolean;
  eol: Eol;
  mtimeMs: number;
  /** 编辑器里的内容相对磁盘有改动。 */
  dirty: boolean;
  /** 用户选了统一换行，内容没动但保存后行尾会变。 */
  eolChanged: boolean;
  readOnly: boolean;
  /** 只读原因：混合换行（可统一后解锁）/ 字符无法无损往返（不可解锁）。 */
  readOnlyReason: "mixed" | "lossy" | null;
  /** 打开时的行数。超过阈值要提示「语义补全不可用」，不必为了它再读一次文件。 */
  lines: number;
  /**
   * 虚拟文件（不在磁盘上）：jar 内的类，`path` 是 jdt:// 地址。
   * `source` = 有真实源码（配了 _src.jar），`stub` = 只有方法签名，
   * `decompiled` = 没有源码，正文由 CFR 反编译得到。不可编辑、不可保存、不可编译。
   */
  virtual?: "source" | "stub" | "decompiled";
  /** 反编译失败原因，用于签名桩上的组件下载引导。 */
  decompileError?: string;
  /**
   * 预览标签：文件树单击打开，斜体显示，会被下一次单击预览替换；
   * 双击标签 / 双击树里的文件 / 开始编辑后固定。
   */
  preview?: boolean;
}

export interface WorkspaceSession {
  editorGroups?: EditorGroups;
  /**
   * 当前工作区根目录。`undefined` = 还在读取配置，`null` = 尚未选择。
   * 放这里是为了切回文件页时不必等一次 IPC 才画出文件树（否则每切回来都闪一下空屏）。
   */
  root: string | null | undefined;
  tabs: TabMeta[];
  activePath: string | null;
  /**
   * 右侧分屏里显示的文件。null = 没有分屏。
   *
   * 分屏只是「另一个入口」：文件仍必须是已打开的标签（`openSplit` 会先打开它），
   * 关标签 / 改名 / 删除时跟着走。会话级而不是组件级——切页卸载回来分屏还在。
   */
  splitPath: string | null;
  tree: TreeState;
  panelOpen: boolean;
  panelTab: PanelTab;
  /** NC 控制台临时展开阅读；恢复时保留用户原来的停靠高度。 */
  serviceExpanded?: boolean;
  /**
   * 「问题」面板只看某个文件（树右键「查看该文件的 N 个问题」设置）。
   * 放会话里而不是面板本地 state：设置入口在文件树，面板可能还没挂载/被切走。
   */
  problemsPath: string | null;
  problemsPathScope?: import("./diagnosticScope").ProblemPathScope;
  /** 编译在跑。放这里是因为编译可能在切页期间结束，回调要写回仓库。 */
  compiling: boolean;
  /** 模块级进度（`build-progress`）；单模块编译没有这个事件，值为 null。 */
  buildProgress: BuildProgress | null;
  compileResult: CompileResult | null;
  compileLog: string[];
  compileResourceMissing?: boolean;
  /**
   * 用户关掉了「大文件」提示的文件。放仓库里是因为切页会卸载文件页——
   * 关了又回来还弹一次，等于没关。
   */
  largeHintDismissed: string[];
  /**
   * 保存遇到异地修改（磁盘上的文件被别的进程改了），等用户选「覆盖 / 重新加载」。
   * 放仓库里：这是「有未保存改动」的第二种形态，切页回来必须还在，
   * 否则用户会以为提示已经消失、改动已经保存好了。
   */
  conflictPath: string | null;
  /** 关标签时遇到未保存改动，等用户确认。同样不能随卸载消失。 */
  closingPath: string | null;
  /**
   * 保存被**编码**挡住：GBK 文件里写进了它表示不了的字符，只能转 UTF-8。
   * 以前这里只弹一条 toast「请改用 UTF-8 保存」，而全界面没有切换编码的入口——
   * 死路，Ctrl+S 永远失败。现在挂起成一个带按钮的提示条。
   */
  encodingIssue: { path: string; message: string } | null;
}

let state: WorkspaceSession = {
  root: undefined,
  tabs: [],
  activePath: null,
  splitPath: null,
  tree: { root: null, expanded: new Set<string>(), dirs: {}, marks: {} },
  panelOpen: true,
  panelTab: "problems",
  serviceExpanded: false,
  problemsPath: null,
  compiling: false,
  buildProgress: null,
  compileResult: null,
  compileLog: [],
  largeHintDismissed: [],
  conflictPath: null,
  closingPath: null,
  encodingIssue: null,
};

const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

/** 订阅变更（useSyncExternalStore 与单测共用）。返回取消订阅函数。 */
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): WorkspaceSession {
  return state;
}

export type Updater<T> = T | ((prev: T) => T);

export type SessionPatch = Partial<{
  [K in keyof WorkspaceSession]: Updater<WorkspaceSession[K]>;
}>;

/**
 * 局部更新。值是函数就当成 updater（和 React 的 setState 同语义）。
 * 值没变（引用相同）就不广播，避免 `setTabs((ts) => ts)` 这类空操作触发重渲染。
 */
export function setSession(patch: SessionPatch): void {
  const changes: Partial<WorkspaceSession> = {};
  let touched = false;
  for (const key of Object.keys(patch) as (keyof WorkspaceSession)[]) {
    const v = patch[key];
    // 这些字段都不是函数类型，可以安全地用 typeof 判 updater
    const value =
      typeof v === "function" ? (v as (prev: unknown) => unknown)(state[key]) : v;
    if (value !== state[key]) {
      Object.assign(changes, { [key]: value });
      touched = true;
    }
  }
  if (touched) {
    const next = { ...state, ...changes };
    state = ["tabs", "root", "activePath", "splitPath", "editorGroups"].some(key => key in changes)
      ? reconcileEditorGroups(state, next, changes) : next;
    emit();
  }
}

/** 读当前快照（非 React 环境用，比如事件回调里判断）。 */
export function getSession(): WorkspaceSession {
  return state;
}

/** 更新文件树状态（展开态 + 目录缓存）。 */
export function setTree(fn: (tree: TreeState) => TreeState): void {
  setSession({ tree: fn });
}

/**
 * 订阅会话态。
 *
 * 这里用 useSyncExternalStore 而不是 useState + 手动订阅：文件页卸载期间
 * 仓库仍会被写（编译结束、dirty 翻转），重新挂载时必须立刻拿到最新快照，
 * 不能用 effect 里补一次 setState（那会多渲染一帧空标签栏）。
 */
export function useWorkspaceSession(): WorkspaceSession {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 只订阅工作区根目录。整会话订阅会让隐藏页在每次 dirty 翻转时跟着重渲染。 */
export function useWorkspaceRoot(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => state.root ?? null,
    () => state.root ?? null,
  );
}

/**
 * 只订阅会话的一个切片。
 *
 * `useWorkspaceSession()` 返回整份快照：任何一个字段变化（编译状态、某个标签 dirty、
 * 目录缓存）都会让**全部**订阅者重渲染。文件页一次解构十来个字段，等于每次都全量刷新。
 *
 * 实现是 `useSyncExternalStore` + 记忆化选择器：快照本身仍是整份，但只有选中值
 * 真的变了（按 `isEqual`）才换引用、才触发重渲染。
 *
 * ⚠️ 选择器必须返回**稳定引用**：`s => s.tabs` 没问题（数组只在真正变更时换新对象），
 * 但 `s => ({ a: s.a })` 每次都是新对象——要么自己 `useMemo`，要么传 `isEqual` 做浅比较。
 */
export function useWorkspaceSelector<T>(
  selector: (s: WorkspaceSession) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  // 选择器与比较函数放 ref：调用方常写内联箭头，放进依赖会让订阅每次渲染都重来一遍。
  const sel = useRef(selector);
  const eq = useRef(isEqual);
  sel.current = selector;
  eq.current = isEqual;
  const memo = useRef<{ has: boolean; value: T } | null>(null);
  const getSelection = useCallback(() => {
    const next = sel.current(state);
    const m = memo.current;
    if (m && m.has && eq.current(m.value, next)) return m.value;
    memo.current = { has: true, value: next };
    return next;
  }, []);
  return useSyncExternalStore(subscribe, getSelection, getSelection);
}

// 「未保存」圆点要跟着编辑器走，但订阅不能绑在组件上——文件页卸载后
// dirty 仍会变化（比如编译前的保存提醒），回来后圆点必须是准的。
onDirtyChange((path, dirty) => {
  if (!state.tabs.some((t) => t.path === path && t.dirty !== dirty)) return;
  // 开始编辑 = 用户认定这个文件要留着，预览标签顺势固定
  setSession({
    tabs: (prev) =>
      prev.map((t) => (t.path === path ? { ...t, dirty, ...(dirty ? { preview: false } : {}) } : t)),
  });
});
