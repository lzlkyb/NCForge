import { createSessionStore, useSessionStore } from "./sessionStore";
import { keyOf, type SortMode } from "./svn";
import { SVN_FILTERS, type SvnFilter } from "./svnList";
export interface SvnListPrefs { filter: SvnFilter; search: string; sort: SortMode; closed: string[]; scroll: number; }
const stores = new Map<string, ReturnType<typeof createSessionStore<SvnListPrefs>>>();
function listStore(root: string | null) {
  const key = `ncforge.svn.list:${keyOf(root ?? "")}`;
  let store = stores.get(key);
  if (store) return store;
  let value: SvnListPrefs = { filter: "all", search: "", sort: "path", closed: [], scroll: 0 };
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    if (saved) value = { filter: saved.filter in SVN_FILTERS ? saved.filter : "all", search: typeof saved.search === "string" ? saved.search : "", sort: saved.sort === "mtime" ? "mtime" : "path", closed: Array.isArray(saved.closed) ? saved.closed.filter((s: unknown) => typeof s === "string") : [], scroll: typeof saved.scroll === "number" ? saved.scroll : 0 };
  } catch { /* 本机偏好不可读时使用默认值。 */ }
  store = createSessionStore(value);
  const current = store;
  store.subscribe(() => { try { localStorage.setItem(key, JSON.stringify(current.get())); } catch { /* 本次会话仍保留偏好。 */ } });
  stores.set(key, store);
  return store;
}
export const useSvnListPrefs = (root: string | null) => useSessionStore(listStore(root));
export const setSvnListPrefs = (root: string | null, patch: Partial<SvnListPrefs>) => listStore(root).set(patch);
