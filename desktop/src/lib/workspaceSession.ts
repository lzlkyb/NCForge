import { useSyncExternalStore } from "react";
import type { PanelTab } from "../components/workspace/BottomPanel";
import type { CompileResult } from "./compile";
import { onDirtyChange } from "./editorStore";
import type { DirItem, EncodingMark, Eol, TextEncoding } from "./workspace";

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
}

export interface WorkspaceSession {
  /**
   * 当前工作区根目录。`undefined` = 还在读取配置，`null` = 尚未选择。
   * 放这里是为了切回文件页时不必等一次 IPC 才画出文件树（否则每切回来都闪一下空屏）。
   */
  root: string | null | undefined;
  tabs: TabMeta[];
  activePath: string | null;
  tree: TreeState;
  panelOpen: boolean;
  panelTab: PanelTab;
  /** 编译在跑。放这里是因为编译可能在切页期间结束，回调要写回仓库。 */
  compiling: boolean;
  compileResult: CompileResult | null;
  compileLog: string[];
  /**
   * 用户关掉了「大文件」提示的文件。放仓库里是因为切页会卸载文件页——
   * 关了又回来还弹一次，等于没关。
   */
  largeHintDismissed: string[];
}

let state: WorkspaceSession = {
  root: undefined,
  tabs: [],
  activePath: null,
  tree: { root: null, expanded: new Set<string>(), dirs: {}, marks: {} },
  panelOpen: true,
  panelTab: "problems",
  compiling: false,
  compileResult: null,
  compileLog: [],
  largeHintDismissed: [],
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
    state = { ...state, ...changes };
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

// 「未保存」圆点要跟着编辑器走，但订阅不能绑在组件上——文件页卸载后
// dirty 仍会变化（比如编译前的保存提醒），回来后圆点必须是准的。
onDirtyChange((path, dirty) => {
  if (!state.tabs.some((t) => t.path === path && t.dirty !== dirty)) return;
  setSession({ tabs: (prev) => prev.map((t) => (t.path === path ? { ...t, dirty } : t)) });
});
