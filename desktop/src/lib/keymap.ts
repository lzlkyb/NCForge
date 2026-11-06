import { getBindingOverride } from "./keybindings";

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

/** 设置页展示用：固定入口 + 当前方案的等价键（改过自定义键位时显示改后的）。 */
export function workspaceSearchLabel(keymap: Keymap): string {
  const custom = getBindingOverride("search.workspace");
  const scheme = custom
    ? prettyChord(custom)
    : keymap === "eclipse"
      ? "Ctrl+H"
      : "Ctrl+Shift+F";
  return `${WORKSPACE_SEARCH_KEY} / ${scheme}`;
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
  if (event.metaKey || event.isComposing) return false;
  const custom = getBindingOverride("search.workspace");
  if (custom) return eventChord(event) === custom;
  if (!event.ctrlKey || event.altKey) return false;
  const key = event.key.toLowerCase();
  return keymap === "eclipse" ? !event.shiftKey && key === "h" : event.shiftKey && key === "f";
}

/** 与按键判定同一口径的绑定串（`ctrl+shift+f`）。 */
function eventChord(event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "key">): string {
  const k = event.key === " " ? "space" : event.key.toLowerCase();
  return `${event.ctrlKey ? "ctrl+" : ""}${event.altKey ? "alt+" : ""}${event.shiftKey ? "shift+" : ""}${k}`;
}

/** 类型层级入口键：IDEA 是 Ctrl+H，Eclipse 是 Ctrl+T（那边的 Ctrl+H 留给全工程搜索）。 */
export function isTypeHierarchyKey(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "key" | "isComposing">, keymap: Keymap): boolean {
  if (event.metaKey || event.isComposing) return false;
  const custom = getBindingOverride("hierarchy.type");
  if (custom) return eventChord(event) === custom;
  if (!event.ctrlKey || event.altKey || event.shiftKey) return false;
  const key = event.key.toLowerCase();
  return keymap === "idea" ? key === "h" : key === "t";
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
  if (event.isComposing || event.metaKey) return;
  const key = event.key === " " ? "space" : event.key.toLowerCase();
  const chord = `${event.ctrlKey ? "ctrl+" : ""}${event.altKey ? "alt+" : ""}${event.shiftKey ? "shift+" : ""}${key}`;
  // 改过键位的动作只认新键：旧默认键必须让出来，否则一处动作能从一个没显示在设置里的键触发
  for (const row of EDITOR_KEYS) {
    const custom = getBindingOverride(`editor.${row.action}`);
    if (custom ? custom === chord : row[keymap].toLowerCase() === chord) return row.action;
  }
  return undefined;
}

/** 快速导航浮层的五种模式：转到文件 / 类型 / 当前文件符号 / 工作区符号 / 命令。 */
export type PaletteMode = "file" | "type" | "symbol" | "sym" | "cmd";

/**
 * 各模式的入口键，第一项是展示用的首选键。
 *
 * `Ctrl+P`（转到文件）与 `Ctrl+Shift+P`（命令）两套方案通用：这是绝大多数编辑器的习惯，
 * 而且与 Eclipse / IDEA 方案里已有的键都不冲突。
 *
 * `sym`（工作区符号 = 方法/字段级搜索）在两套方案下都用 `Ctrl+Alt+N`：IDEA 原本是
 * `Ctrl+Alt+Shift+N`，但那套键在 Windows 的某些输入法/系统热键下会被吃掉，
 * 这里给它一个稳的等价键（设置页的说明也按这个写）。
 */
const PALETTE_KEYS: Record<PaletteMode, Record<Keymap, string[]>> = {
  file: { eclipse: ["ctrl+shift+r", "ctrl+p"], idea: ["ctrl+shift+n", "ctrl+p"] },
  type: { eclipse: ["ctrl+shift+t"], idea: ["ctrl+n"] },
  symbol: { eclipse: ["ctrl+o"], idea: ["ctrl+f12"] },
  sym: { eclipse: ["ctrl+alt+n"], idea: ["ctrl+alt+n", "ctrl+alt+shift+n"] },
  cmd: { eclipse: ["ctrl+shift+p"], idea: ["ctrl+shift+p", "ctrl+shift+a"] },
};

export const PALETTE_MODES: { mode: PaletteMode; label: string }[] = [
  { mode: "file", label: "文件" },
  { mode: "type", label: "类型" },
  { mode: "symbol", label: "符号" },
  { mode: "sym", label: "工作区符号" },
  { mode: "cmd", label: "命令" },
];

/** 改过键位就只认改后的那一个（默认的多个等价键一起让出）。 */
function paletteChords(mode: PaletteMode, keymap: Keymap): string[] {
  const custom = getBindingOverride(`palette.${mode}`);
  return custom ? [custom] : PALETTE_KEYS[mode][keymap];
}

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "isComposing">;

/** 这次按键是不是某个浮层模式的入口键；不是返回 null。 */
export function paletteModeOf(event: KeyLike, keymap: Keymap): PaletteMode | null {
  // Alt 要参与拼键（工作区符号是 Ctrl+Alt+N），所以这里不排除 altKey
  if (event.isComposing || event.metaKey || !event.ctrlKey) return null;
  const chord = `ctrl+${event.altKey ? "alt+" : ""}${event.shiftKey ? "shift+" : ""}${event.key.toLowerCase()}`;
  for (const mode of Object.keys(PALETTE_KEYS) as PaletteMode[]) {
    if (paletteChords(mode, keymap).includes(chord)) return mode;
  }
  return null;
}

/** 展示用：`ctrl+shift+r` → `Ctrl+Shift+R`。 */
export function prettyChord(chord: string): string {
  return chord
    .split("+")
    .map((p) => (p.length <= 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join("+");
}

/** 首选键，给浮层按钮、标题栏输入框的提示用。 */
export function paletteKeyLabel(mode: PaletteMode, keymap: Keymap): string {
  return prettyChord(paletteChords(mode, keymap)[0]);
}

/** 该模式在当前方案下的全部键（设置页的说明表用）。 */
export function paletteKeysLabel(mode: PaletteMode, keymap: Keymap): string {
  return paletteChords(mode, keymap).map(prettyChord).join(" / ");
}

/** 展开 / 收起主导航栏（图标栏 ↔ 带页名）的默认键。展示与判定都从这里派生。 */
const RAIL_DEFAULT = "ctrl+shift+b";
export const RAIL_KEY = prettyChord(RAIL_DEFAULT);

/** 当前生效的导航栏键位展示串（用户改过就用改后的）。 */
export function railKeyLabel(): string {
  return prettyChord(getBindingOverride("layout.rail") ?? RAIL_DEFAULT);
}

/** `aria-keyshortcuts` 要求 `Control+Shift+B` 这种写法，与展示串不能直接复用。 */
export function railAriaKey(): string {
  return (getBindingOverride("layout.rail") ?? RAIL_DEFAULT)
    .split("+")
    .map((p) =>
      p === "ctrl" ? "Control" : p === "alt" ? "Alt" : p === "shift" ? "Shift" : p === "meta" ? "Meta" : p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1),
    )
    .join("+");
}

/** 布局类快捷键（两套方案一致）：切侧栏 / 切底部面板 / 展开导航栏。 */
export function layoutKeyOf(event: KeyLike): "side" | "panel" | "rail" | null {
  if (event.isComposing || event.metaKey) return null;
  const chord = eventChord(event);
  const side = getBindingOverride("layout.side");
  const panel = getBindingOverride("layout.panel");
  const rail = getBindingOverride("layout.rail");
  if (side && chord === side) return "side";
  if (panel && chord === panel) return "panel";
  if (rail && chord === rail) return "rail";
  if (!event.ctrlKey || event.altKey) return null;
  const k = event.key.toLowerCase();
  // Shift 只放行导航栏那一键：Ctrl+B / Ctrl+J 带 Shift 仍是别的编辑器动作
  if (!rail && chord === RAIL_DEFAULT) return "rail";
  if (event.shiftKey) return null;
  if (!side && k === "b") return "side";
  if (!panel && k === "j") return "panel";
  return null;
}

/**
 * 重新打开关闭的标签。
 *
 * Ctrl+Shift+T 在 IDEA / VS Code 是「恢复关闭的标签」，但在 Eclipse 是「打开类型」——
 * 两套方案不能共用。Eclipse 方案把恢复挪到 Ctrl+Alt+T，把 Ctrl+Shift+T 还给转到类型；
 * 用户也可以在设置里改。
 */
export function isReopenTabKey(event: KeyLike, keymap: Keymap): boolean {
  if (event.metaKey || event.isComposing || !event.ctrlKey) return false;
  const chord = getBindingOverride("tab.reopen") ?? (keymap === "eclipse" ? "ctrl+alt+t" : "ctrl+shift+t");
  return eventChord(event) === chord;
}

const TAB_KEYS = { next: "ctrl+tab", previous: "ctrl+shift+tab", left: "ctrl+alt+arrowleft", right: "ctrl+alt+arrowright" } as const;
export type TabKeyAction = keyof typeof TAB_KEYS;
export function tabKeyLabel(action: TabKeyAction): string { return prettyChord(getBindingOverride(`tab.${action}`) ?? TAB_KEYS[action]); }
export function tabKeyAction(event: KeyLike): TabKeyAction | null {
  if (event.metaKey || event.isComposing) return null;
  return (Object.keys(TAB_KEYS) as TabKeyAction[]).find(action => eventChord(event) === (getBindingOverride(`tab.${action}`) ?? TAB_KEYS[action])) ?? null;
}

/* ─── 设置页的键位总表（默认值 + 用户覆盖） ─── */

export type BindingGroup = "快速导航" | "窗口" | "搜索与层级" | "编辑器" | "固定键";

export interface BindingRow {
  id: string;
  label: string;
  group: BindingGroup;
  /** 生效中的全部组合键（小写、`ctrl+shift+r` 形式）。 */
  keys: string[];
  /** 展示串；空数组表示该方案下这个动作没有默认键（可用自定义键补上）。 */
  display: string[];
  /** 用户改过（可恢复默认）。 */
  overridden: boolean;
}

/**
 * 键位总表：设置页展示与冲突判定共用同一份数据。
 * 搜索那行保留固定的 Ctrl+K（它是顶栏入口，不参与自定义），所以自定义方案键后仍显示两个。
 */
export function isDbObjectKey(e: KeyboardEvent): boolean {return !e.isComposing && !e.metaKey && eventChord(e) === (getBindingOverride("db.objects") ?? "ctrl+alt+o");}
export function bindingRows(keymap: Keymap): BindingRow[] {
  const rows: BindingRow[] = [];
  const add = (id: string, label: string, group: BindingGroup, defaults: string[]) => {
    const custom = getBindingOverride(id);
    const keys = custom ? [custom] : defaults;
    rows.push({ id, label, group, keys, display: keys.map(prettyChord), overridden: !!custom });
  };
  for (const { mode, label } of PALETTE_MODES) {
    add(`palette.${mode}`, `转到${label}`, "快速导航", PALETTE_KEYS[mode][keymap]);
  }
  add("layout.side", "切换侧栏", "窗口", ["ctrl+b"]);
  add("layout.panel", "切换底部面板", "窗口", ["ctrl+j"]);
  add("layout.rail", "展开 / 收起导航栏", "窗口", ["ctrl+shift+b"]);
  add("tab.reopen", "重新打开关闭的标签", "窗口", [keymap === "eclipse" ? "ctrl+alt+t" : "ctrl+shift+t"]);
  for (const [action, label] of [["next", "当前组最近文件"], ["previous", "当前组较早文件"], ["left", "聚焦左编辑器组"], ["right", "聚焦右编辑器组"]] as const) add(`tab.${action}`, label, "窗口", [TAB_KEYS[action]]);
  const searchCustom = getBindingOverride("search.workspace");
  const searchScheme = keymap === "eclipse" ? "ctrl+h" : "ctrl+shift+f";
  // Ctrl+K 永远有效，所以即使改了方案键，冲突表里也要把它算作占用
  rows.push({
    id: "search.workspace",
    label: "全工程搜索",
    group: "搜索与层级",
    keys: [...(searchCustom ? [searchCustom] : [searchScheme]), "ctrl+k"],
    display: [searchCustom ? prettyChord(searchCustom) : prettyChord(searchScheme), prettyChord("ctrl+k")],
    overridden: !!searchCustom,
  });
  add("db.objects", "查找数据库对象", "搜索与层级", ["ctrl+alt+o"]);
  add("hierarchy.type", "类型层级", "搜索与层级", [keymap === "idea" ? "ctrl+h" : "ctrl+t"]);
  for (const row of EDITOR_KEYS) {
    const def = row[keymap] === "—" ? [] : [row[keymap].toLowerCase()];
    add(`editor.${row.action}`, row.label, "编辑器", def);
  }
  return rows;
}
