import { useCallback, useEffect, useSyncExternalStore } from "react";
import { invoke } from "../lib/tauri";
import { isUnderPath } from "../lib/treeProjects";
import { isJavaSourceRoot, type PackageIndex, type PackageIndexes, type PackageRoots } from "../lib/packageTree";
import { getSession } from "../lib/workspaceSession";
import { workspaceEpoch } from "../lib/workspaceEpoch";

function createCache(owner: string, epoch: number) {
  const listeners = new Set<() => void>();
  let indexes: PackageIndexes = new Map();
  return {
    owner, epoch, needsValidation: false,
    pending: new Map<string, Promise<PackageIndex>>(),
    dirty: new Set<string>(),
    getSnapshot: () => indexes,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    publish(source: string, index: PackageIndex) {
      indexes = new Map(indexes).set(source, index);
      listeners.forEach(listener => listener());
    },
  };
}

let currentCache: ReturnType<typeof createCache> | undefined;

export function usePackageIndexes(owner: string, roots: PackageRoots | undefined, expanded: Set<string>, epoch: number) {
  if (currentCache?.owner !== owner || currentCache.epoch !== epoch) currentCache = createCache(owner, epoch);
  const cache = currentCache;
  const indexes = useSyncExternalStore(cache.subscribe, cache.getSnapshot);
  const ensure = useCallback(function request(root: string): Promise<PackageIndex> {
    if (workspaceEpoch() !== cache.epoch || currentCache !== cache) return Promise.resolve(null);
    const running = cache.pending.get(root);
    if (running) return running;
    const cached = cache.getSnapshot().get(root);
    const dirty = cache.dirty.delete(root);
    if (cached !== undefined && !dirty) return Promise.resolve(cached);
    const read = invoke<PackageIndex>("fs_package_dirs", { path: root }).catch(() => null).then(index => {
      cache.pending.delete(root);
      if (workspaceEpoch() !== cache.epoch || currentCache !== cache) return null;
      // Changes during a scan need a second pass so an old result cannot hide a new package.
      if (cache.dirty.has(root)) return request(root);
      cache.publish(root, index);
      return index;
    });
    cache.pending.set(root, read);
    return read;
  }, [cache]);

  const invalidate = useCallback((paths: string[], rescan = false, eager = true) => {
    for (const source of new Set([...cache.getSnapshot().keys(), ...cache.pending.keys()])) {
      if (!rescan && !paths.some(path => isUnderPath(path, source) || isUnderPath(source, path))) continue;
      cache.dirty.add(source);
      if (eager && getSession().tree.expanded.has(source)) void ensure(source);
    }
  }, [cache, ensure]);

  useEffect(() => {
    // The file watcher is attached to the tree. Validate again after a detached period
    // while the previous snapshot stays visible.
    if (cache.needsValidation) {
      invalidate([], true, false);
      cache.needsValidation = false;
    }
    return () => { cache.needsValidation = true; };
  }, [cache, invalidate]);

  useEffect(() => {
    if (!roots) return;
    for (const group of roots.values()) {
      for (const source of group) if (expanded.has(source) && isJavaSourceRoot(source)) void ensure(source);
    }
  }, [roots, expanded, ensure]);

  return { indexes, ensure, invalidate };
}
