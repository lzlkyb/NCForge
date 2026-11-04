// 编辑器偏好：字号 / 字体 / 换行 / 缩进 / 小地图 / 粘性滚动 / 错误内联 / 自动保存。
//
// 放 localStorage 而不是 AppConfig：这些是**本机显示习惯**，不该跟着配置导入导出
// 跑到同事机器上（`config_io` 的白名单也不含它们）。按工作区不隔离——同一个人
// 换工程不该重新调一遍字号。
//
// 与 keymap 同一套范式：模块级读缓存 + 事件通知（`useSyncExternalStore` 订阅），
// 不引入 React Context，编辑器（非 React 的 Monaco 实例）也能直接读。
import { useSyncExternalStore } from "react";

const KEY = "ncforge-editor-prefs";
export const PREFS_EVENT = "ncforge-editor-prefs-change";

export interface EditorPrefs {
  fontSize: number;
  /** 空串 = 用默认字体栈。 */
  fontFamily: string;
  wordWrap: boolean;
  /** 缩进宽度（空格数）。 */
  tabSize: number;
  /** true = 用空格缩进；NC 代码是制表符，默认 false。 */
  insertSpaces: boolean;
  minimap: boolean;
  stickyScroll: boolean;
  /** 行尾内联显示诊断（Error Lens）。 */
  errorLens: boolean;
  /** 停止输入后自动保存。默认关：NC 代码常在调试中途保存，自动落盘会打断「改一半就编译」的节奏。 */
  autoSave: boolean;
  autoSaveDelayMs: number;
  /** 保存（Ctrl+S / 自动保存）前先格式化 Java 文件。默认关：格式化会重排整份文件，不是所有人都想要。 */
  formatOnSave: boolean;
}

export const DEFAULT_PREFS: EditorPrefs = {
  fontSize: 13,
  fontFamily: "",
  wordWrap: false,
  tabSize: 4,
  insertSpaces: false,
  minimap: true,
  stickyScroll: false,
  errorLens: true,
  autoSave: false,
  autoSaveDelayMs: 2000,
  formatOnSave: false,
};

let cache: EditorPrefs = load();
let lastWriteSucceeded = true;
const listeners = new Set<() => void>();

function load(): EditorPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<EditorPrefs>;
    // 逐字段合并：老版本存下来的对象缺字段时，用默认值补齐而不是整体失效
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function getEditorPrefs(): EditorPrefs {
  return cache;
}

export function setEditorPrefs(patch: Partial<EditorPrefs>): boolean {
  const next = { ...cache, ...patch };
  const changed = !(Object.keys(patch) as (keyof EditorPrefs)[]).every((k) => cache[k] === next[k]);
  // Retry an identical value only after a failed write; otherwise keep no-op updates cheap.
  if (!changed && lastWriteSucceeded) return true;
  cache = next;
  let stored = true;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Keep the existing session-only fallback; settings must disclose that it was not persisted.
    stored = false;
  }
  if (changed) {
    window.dispatchEvent(new Event(PREFS_EVENT));
    listeners.forEach((l) => l());
  }
  lastWriteSucceeded = stored;
  return stored;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React 侧订阅（设置页用）。 */
export function useEditorPrefs(): EditorPrefs {
  return useSyncExternalStore(subscribe, getEditorPrefs, getEditorPrefs);
}

/** Monaco 的 `updateOptions` 片段：只映射与选项有关的字段。 */
export function monacoOptionsOf(p: EditorPrefs): Record<string, unknown> {
  return {
    fontSize: p.fontSize,
    fontFamily: p.fontFamily || '"Cascadia Mono", Consolas, "Courier New", monospace',
    wordWrap: p.wordWrap ? "on" : "off",
    tabSize: p.tabSize,
    insertSpaces: p.insertSpaces,
    minimap: { enabled: p.minimap, showSlider: "mouseover" },
    stickyScroll: { enabled: p.stickyScroll },
  };
}
