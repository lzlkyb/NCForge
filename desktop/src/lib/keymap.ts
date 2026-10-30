export type Keymap = "eclipse" | "idea";
const KEY = "ncforge-keymap";

/**
 * 全工程搜索的入口键。
 *
 * 三处必须同源，别再各写一句：顶栏搜索框的 kbd 提示、设置页的说明文字、
 * `isWorkspaceSearch` 的实际判定。历史上顶栏只写 Ctrl+K、设置页只写 Ctrl+H，
 * 用户按哪个都找不到第三处——这里是唯一事实来源。
 */
export const WORKSPACE_SEARCH_CHAR = "K";
export const WORKSPACE_SEARCH_KEY = `Ctrl+${WORKSPACE_SEARCH_CHAR}`;

/** 设置页展示用：固定入口 + 当前方案的等价键。 */
export function workspaceSearchLabel(keymap: Keymap): string {
  return keymap === "eclipse" ? `${WORKSPACE_SEARCH_KEY} / Ctrl+H` : `${WORKSPACE_SEARCH_KEY} / Ctrl+Shift+F`;
}

export function getKeymap(): Keymap {
  try { return localStorage.getItem(KEY) === "idea" ? "idea" : "eclipse"; }
  catch { return "eclipse"; }
}

export function setKeymap(value: Keymap): void {
  localStorage.setItem(KEY, value);
  window.dispatchEvent(new Event("ncforge-keymap-change"));
}

/** Only claim shortcuts whose operations actually exist in the workbench. */
export function isWorkspaceSearch(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "key" | "isComposing">, keymap: Keymap): boolean {
  if (!event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
  const key = event.key.toLowerCase();
  return keymap === "eclipse" ? !event.shiftKey && key === "h" : event.shiftKey && key === "f";
}

export const EDITOR_KEYS = [
  { label: "查找", eclipse: "Ctrl+F", idea: "Ctrl+F", action: "actions.find" },
  { label: "替换（Eclipse 方案从查找框展开）", eclipse: "—", idea: "Ctrl+R", action: "editor.action.startFindReplaceAction" },
  { label: "跳转到行", eclipse: "Ctrl+L", idea: "Ctrl+G", action: "editor.action.gotoLine" },
  { label: "跳转定义", eclipse: "F3", idea: "Ctrl+B", action: "editor.action.revealDefinition" },
  { label: "代码补全", eclipse: "Ctrl+Space", idea: "Ctrl+Space", action: "editor.action.triggerSuggest" },
  { label: "行注释", eclipse: "Ctrl+/", idea: "Ctrl+/", action: "editor.action.commentLine" },
  { label: "删除当前行", eclipse: "Ctrl+D", idea: "Ctrl+Y", action: "editor.action.deleteLines" },
  { label: "重做", eclipse: "Ctrl+Y", idea: "Ctrl+Shift+Z", action: "redo" },
] as const;

export function editorCommand(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "isComposing">, keymap: Keymap): string | undefined {
  if (event.isComposing || event.altKey || event.metaKey) return;
  const key = event.key === " " ? "Space" : event.key;
  const chord = `${event.ctrlKey ? "Ctrl+" : ""}${event.shiftKey ? "Shift+" : ""}${key}`.toLowerCase();
  return EDITOR_KEYS.find(row => row[keymap].toLowerCase() === chord)?.action;
}

/** 快速导航浮层的四种模式：转到文件 / 类型 / 当前文件符号 / 命令。 */
export type PaletteMode = "file" | "type" | "symbol" | "cmd";

/**
 * 各模式的入口键，第一项是展示用的首选键。
 *
 * `Ctrl+P`（转到文件）与 `Ctrl+Shift+P`（命令）两套方案通用：这是绝大多数编辑器的习惯，
 * 而且与 Eclipse / IDEA 方案里已有的键都不冲突。
 */
const PALETTE_KEYS: Record<PaletteMode, Record<Keymap, string[]>> = {
  file: { eclipse: ["ctrl+shift+r", "ctrl+p"], idea: ["ctrl+shift+n", "ctrl+p"] },
  type: { eclipse: ["ctrl+shift+t"], idea: ["ctrl+n"] },
  symbol: { eclipse: ["ctrl+o"], idea: ["ctrl+f12"] },
  cmd: { eclipse: ["ctrl+shift+p"], idea: ["ctrl+shift+p", "ctrl+shift+a"] },
};

export const PALETTE_MODES: { mode: PaletteMode; label: string }[] = [
  { mode: "file", label: "文件" },
  { mode: "type", label: "类型" },
  { mode: "symbol", label: "符号" },
  { mode: "cmd", label: "命令" },
];

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "isComposing">;

/** 这次按键是不是某个浮层模式的入口键；不是返回 null。 */
export function paletteModeOf(event: KeyLike, keymap: Keymap): PaletteMode | null {
  if (event.isComposing || event.altKey || event.metaKey || !event.ctrlKey) return null;
  const chord = `ctrl+${event.shiftKey ? "shift+" : ""}${event.key.toLowerCase()}`;
  for (const mode of Object.keys(PALETTE_KEYS) as PaletteMode[]) {
    if (PALETTE_KEYS[mode][keymap].includes(chord)) return mode;
  }
  return null;
}

/** 展示用：`ctrl+shift+r` → `Ctrl+Shift+R`。 */
function prettyChord(chord: string): string {
  return chord
    .split("+")
    .map((p) => (p.length <= 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join("+");
}

/** 首选键，给浮层按钮、标题栏输入框的提示用。 */
export function paletteKeyLabel(mode: PaletteMode, keymap: Keymap): string {
  return prettyChord(PALETTE_KEYS[mode][keymap][0]);
}

/** 该模式在当前方案下的全部键（设置页的说明表用）。 */
export function paletteKeysLabel(mode: PaletteMode, keymap: Keymap): string {
  return PALETTE_KEYS[mode][keymap].map(prettyChord).join(" / ");
}

/** 布局类快捷键（两套方案一致）：切侧栏 / 切底部面板。 */
export function layoutKeyOf(event: KeyLike): "side" | "panel" | null {
  if (event.isComposing || event.altKey || event.metaKey || event.shiftKey || !event.ctrlKey) return null;
  const k = event.key.toLowerCase();
  return k === "b" ? "side" : k === "j" ? "panel" : null;
}
