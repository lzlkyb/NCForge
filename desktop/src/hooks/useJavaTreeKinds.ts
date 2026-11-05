import { useEffect, useState } from "react";
import { invoke } from "../lib/tauri";
import type { TreeDirState } from "../lib/workspaceSession";
import type { JavaTreeKind } from "../lib/treeFileKind";

type Kinds = Readonly<Record<string, JavaTreeKind>>;
const EMPTY: Kinds = {};
const cache = new WeakMap<TreeDirState, { pending: Promise<Kinds>; result?: Kinds }>();
const BATCH = 64;

function request(dir: string, state: TreeDirState) {
  const existing = cache.get(state);
  if (existing) return existing;
  const names = state.status === "ok" ? state.items.filter(item => !item.isDir && /\.java$/i.test(item.name)).map(item => item.name) : [];
  const entry: { pending: Promise<Kinds>; result?: Kinds } = {
    pending: (async () => {
      const result: Record<string, JavaTreeKind> = {};
      for (let i = 0; i < names.length; i += BATCH) {
        const kinds = await invoke<Kinds>("fs_java_kinds", { path: dir, names: names.slice(i, i + BATCH) }).catch(() => null);
        if (kinds) Object.assign(result, kinds);
      }
      return result;
    })(),
  };
  cache.set(state, entry);
  void entry.pending.then(result => { entry.result = result; });
  return entry;
}

export function useJavaTreeKinds(dir: string, state: TreeDirState | undefined): Kinds {
  const [snapshot, setSnapshot] = useState<{ state: TreeDirState; kinds: Kinds }>();
  useEffect(() => {
    if (state?.status !== "ok" || !state.items.some(item => !item.isDir && /\.java$/i.test(item.name))) return;
    let active = true;
    // A directory refresh replaces its immutable state, so older results cannot recolor new rows.
    void request(dir, state).pending.then(kinds => { if (active) setSnapshot({ state, kinds }); });
    return () => { active = false; };
  }, [dir, state]);
  if (!state) return EMPTY;
  return snapshot?.state === state ? snapshot.kinds : cache.get(state)?.result ?? EMPTY;
}
