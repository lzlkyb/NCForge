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
};

let cache: EditorPrefs = load();
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

export function setEditorPrefs(patch: Partial<EditorPrefs>): void {
  const next = { ...cache, ...patch };
  // 值没变就不写盘不广播：设置页的滑块会连续触发，没必要每次都惊动编辑器
  if ((Object.keys(patch) as (keyof EditorPrefs)[]).every((k) => cache[k] === next[k])) return;
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // 隐私模式 / 配额满：只在本次会话生效，不打断用户
  }
  window.dispatchEvent(new Event(PREFS_EVENT));
  listeners.forEach((l) => l());
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
