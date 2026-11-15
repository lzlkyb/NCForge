import { createSessionStore, useSessionStore, type SessionStore } from "./sessionStore";

export interface SvnDiffPrefs {
  layout: "auto" | "sideBySide" | "inline";
  ignoreWhitespace: boolean;
  wrap: boolean;
  fontSize: number;
  collapseUnchanged: boolean;
  /** 改动块上方的标注条（谁改的、为什么、审没审、是不是别的需求的）。设计稿拍板 3：默认开。 */
  blockStrips: boolean;
  /** 只看新改动：已审的改动块并进左侧，对比里只剩没审的。 */
  onlyNew: boolean;
}

const defaults: SvnDiffPrefs = { layout: "auto", ignoreWhitespace: false, wrap: true, fontSize: 12, collapseUnchanged: true, blockStrips: true, onlyNew: false };
const stores = new Map<string, SessionStore<SvnDiffPrefs>>();
const keyOf = (root: string | null) => (root ?? "none").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const storageKey = (root: string | null) => `ncforge.svn.diff:${keyOf(root)}`;

function storeOf(root: string | null): SessionStore<SvnDiffPrefs> {
  const key = keyOf(root);
  const existing = stores.get(key);
  if (existing) return existing;
  let prefs = defaults;
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(root)) ?? "null");
    if (value && typeof value === "object") prefs = {
      layout: ["auto", "sideBySide", "inline"].includes(value.layout) ? value.layout : defaults.layout,
      ignoreWhitespace: typeof value.ignoreWhitespace === "boolean" ? value.ignoreWhitespace : defaults.ignoreWhitespace,
      wrap: typeof value.wrap === "boolean" ? value.wrap : defaults.wrap,
      fontSize: [12, 13, 14, 16].includes(value.fontSize) ? value.fontSize : defaults.fontSize,
      collapseUnchanged: typeof value.collapseUnchanged === "boolean" ? value.collapseUnchanged : defaults.collapseUnchanged,
      blockStrips: typeof value.blockStrips === "boolean" ? value.blockStrips : defaults.blockStrips,
      onlyNew: typeof value.onlyNew === "boolean" ? value.onlyNew : defaults.onlyNew,
    };
  } catch { /* 存储不可用时仍能阅读和临时调整。 */ }
  const store = createSessionStore<SvnDiffPrefs>({ ...prefs });
  stores.set(key, store);
  return store;
}

export const getSvnDiffPrefs = (root: string | null): SvnDiffPrefs => storeOf(root).get();
export const useSvnDiffPrefs = (root: string | null): SvnDiffPrefs => useSessionStore(storeOf(root));

export function setSvnDiffPrefs(root: string | null, patch: Partial<SvnDiffPrefs>): void {
  const store = storeOf(root);
  store.set(patch);
  try { localStorage.setItem(storageKey(root), JSON.stringify(store.get())); } catch { /* 本次调整仍生效。 */ }
}
