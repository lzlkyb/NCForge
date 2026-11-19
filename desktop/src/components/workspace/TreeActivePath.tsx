import { createContext, memo, useContext, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import { filePathKey } from "../../lib/workspace";
import { TreeFileRow } from "./TreeRow";

export function createTreeActivePath(path: string | null) {
  let active = path ? filePathKey(path) : null;
  const listeners = new Map<string, Set<() => void>>();
  return {
    isActive: (key: string) => active === key,
    subscribe(key: string, callback: () => void) {
      const set = listeners.get(key) ?? new Set();
      set.add(callback); listeners.set(key, set);
      return () => { set.delete(callback); if (!set.size) listeners.delete(key); };
    },
    update(path: string | null) {
      const next = path ? filePathKey(path) : null;
      if (next === active) return;
      const previous = active; active = next;
      // Tab switching changes two rows, not the shape or metadata of the entire project tree.
      if (previous) listeners.get(previous)?.forEach(callback => callback());
      if (next) listeners.get(next)?.forEach(callback => callback());
    },
  };
}

const ActivePathContext = createContext<ReturnType<typeof createTreeActivePath> | null>(null);

export function TreeActivePath({ path, children }: { path: string | null; children: ReactNode }) {
  const [store] = useState(() => createTreeActivePath(path));
  useLayoutEffect(() => store.update(path), [store, path]);
  return <ActivePathContext.Provider value={store}>{children}</ActivePathContext.Provider>;
}

export const ActiveTreeFileRow = memo(function ActiveTreeFileRow(props: Omit<ComponentProps<typeof TreeFileRow>, "active">) {
  const store = useContext(ActivePathContext);
  const key = filePathKey(props.path);
  const subscribe = useMemo(() => (callback: () => void) => store?.subscribe(key, callback) ?? (() => {}), [store, key]);
  const active = useSyncExternalStore(subscribe, () => store?.isActive(key) ?? false);
  return <TreeFileRow {...props} active={active} />;
});
