// 自定义键位：用户改过的绑定存本机，键位判定处统一查这里。
//
// 只覆盖「应用自己分发」的快捷键（快速导航、布局、搜索/层级、编辑器动作表）。
// Monaco 内置但没进动作表的键（如 F12 定义跳转之外的内部绑定）不在控制范围内，
// UI 也只列确实能生效的项，避免设置页承诺一个按下去没反应的键。
import { isImeComposing } from "./utils";

const KEY = "ncforge-keybindings";
const MAX_OVERRIDES = 64;

export const BINDINGS_EVENT = "ncforge-keybindings-change";

/** 只接受这些命名键；其余多字符键（Dead、Process、Control 等）不算可绑定键。 */
const NAMED_KEYS = new Set([
  "space",
  "enter",
  "escape",
  "tab",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
]);

const PUNCTUATION = new Set(["/", ";", "'", ",", ".", "[", "]", "\\", "-", "=", "`"]);

const F_KEY = /^f(?:[1-9]|1[0-2])$/;

function keyName(raw: string): string | null {
  if (raw === " ") return "space";
  const lower = raw.toLowerCase();
  if (lower === "space") return "space";
  if (lower.length === 1 && /[a-z0-9]/i.test(lower)) return lower;
  if (lower.length === 1 && PUNCTUATION.has(lower)) return lower;
  if (NAMED_KEYS.has(lower)) return lower;
  if (F_KEY.test(lower)) return lower;
  return null;
}

/** `Ctrl+Shift+R` / `ctrl+shift+r` → `ctrl+shift+r`；不合法返回 null。 */
export function normalizeChord(raw: string): string | null {
  const parts = raw.split("+");
  if (parts.length < 2 || parts.length > 4) return null;
  const key = keyName(parts[parts.length - 1]);
  if (!key) return null;
  let ctrl = false;
  let alt = false;
  let shift = false;
  for (const p of parts.slice(0, -1)) {
    const m = p.trim().toLowerCase();
    if (m === "ctrl" || m === "control") {
      if (ctrl) return null;
      ctrl = true;
    } else if (m === "alt") {
      if (alt) return null;
      alt = true;
    } else if (m === "shift") {
      if (shift) return null;
      shift = true;
    } else return null;
  }
  // 没有 Ctrl/Alt 的组合会与普通输入/单键操作抢，直接不收
  if (!ctrl && !alt) return null;
  return `${ctrl ? "ctrl+" : ""}${alt ? "alt+" : ""}${shift ? "shift+" : ""}${key}`;
}

/** 从键盘事件生成绑定串；修饰键本身、输入法组词、Meta 组合都不算。 */
export function chordOfEvent(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "isComposing" | "keyCode">,
): string | null {
  if (isImeComposing(e) || e.metaKey) return null;
  if (!e.ctrlKey && !e.altKey) return null;
  const key = keyName(e.key);
  if (!key) return null;
  return `${e.ctrlKey ? "ctrl+" : ""}${e.altKey ? "alt+" : ""}${e.shiftKey ? "shift+" : ""}${key}`;
}

/**
 * 被固定流程占用的组合，不允许在设置页改成一个实际不生效的键。
 *
 * - `ctrl+s` 由保存流程接管；
 * - `ctrl+1`~`ctrl+9` 由 App 的捕获阶段监听消费（页面切换），设置页的冲突表覆盖不到它们，
 *   登记上来只会得到一个「显示已绑定、按下去切页面」的假绑定。
 */
export const RESERVED_CHORDS = new Set(["ctrl+s", ...Array.from({ length: 9 }, (_, i) => `ctrl+${i + 1}`)]);

/** 保留键的说明文案；不在保留集合里返回 undefined。 */
function reservedReason(chord: string): string | undefined {
  if (chord === "ctrl+s") return "Ctrl+S 固定用于保存，不能占用";
  if (/^ctrl\+[1-9]$/.test(chord)) return `${chord.replace("ctrl+", "Ctrl+")} 固定用于页面切换，不能占用`;
  return undefined;
}

export type BindingResult = { ok: true; chord: string } | { ok: false; error: string };

let cache: Record<string, string> | null = null;

function read(): Record<string, string> {
  if (cache) return cache;
  const out: Record<string, string> = {};
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      let n = 0;
      for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!id || typeof v !== "string") continue;
        const chord = normalizeChord(v);
        if (!chord || RESERVED_CHORDS.has(chord)) continue;
        out[id] = chord;
        if (++n >= MAX_OVERRIDES) break;
      }
    }
  } catch {
    /* 坏数据当没有改过：默认键位永远可用 */
  }
  cache = out;
  return out;
}

export function getBindingOverride(id: string): string | undefined {
  return read()[id];
}

export function setBindingOverride(id: string, raw: string): BindingResult {
  const chord = normalizeChord(raw);
  if (!chord) return { ok: false, error: "需要 Ctrl 或 Alt 加一个键" };
  const reserved = reservedReason(chord);
  if (reserved) return { ok: false, error: reserved };
  const all = { ...read(), [id]: chord };
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    return { ok: false, error: "本机存储写入失败" };
  }
  cache = all;
  window.dispatchEvent(new Event(BINDINGS_EVENT));
  return { ok: true, chord };
}

export function clearBindingOverride(id: string): boolean {
  const all = { ...read() };
  delete all[id];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    return false;
  }
  cache = all;
  window.dispatchEvent(new Event(BINDINGS_EVENT));
  return true;
}

export function clearAllBindings(): boolean {
  try {
    localStorage.removeItem(KEY);
  } catch {
    return false;
  }
  cache = {};
  window.dispatchEvent(new Event(BINDINGS_EVENT));
  return true;
}
