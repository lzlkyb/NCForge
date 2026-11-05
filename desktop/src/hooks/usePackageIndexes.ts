import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "../lib/tauri";
import { isUnderPath } from "../lib/treeProjects";
import { isJavaSourceRoot, type PackageIndex, type PackageIndexes, type PackageRoots } from "../lib/packageTree";
import { getSession } from "../lib/workspaceSession";
import { workspaceEpoch } from "../lib/workspaceEpoch";

const EMPTY_INDEXES: PackageIndexes = new Map();

export function usePackageIndexes(roots: PackageRoots | undefined, expanded: Set<string>, epoch: number) {
  const cache = useMemo(() => ({
    epoch,
    indexes: new Map<string, PackageIndex>(),
    pending: new Map<string, Promise<PackageIndex>>(),
    dirty: new Set<string>(),
  }), [epoch]);
  const [snapshot, publish] = useState<{ epoch: number; indexes: PackageIndexes }>();
  const ensure = useCallback(function request(root: string): Promise<PackageIndex> {
    const running = cache.pending.get(root);
    if (running) return running;
    const cached = cache.indexes.get(root);
    const dirty = cache.dirty.delete(root);
    if (cached !== undefined && !dirty) return Promise.resolve(cached);
    const read = invoke<PackageIndex>("fs_package_dirs", { path: root }).catch(() => null).then(index => {
      cache.indexes.set(root, index);
      cache.pending.delete(root);
      if (workspaceEpoch() !== cache.epoch) return index;
      // Changes during a scan need a second pass so an old result cannot hide a new package.
      if (cache.dirty.has(root)) return request(root);
      publish({ epoch: cache.epoch, indexes: new Map(cache.indexes) });
      return index;
    });
    cache.pending.set(root, read);
    return read;
  }, [cache]);

  const invalidate = useCallback((paths: string[], rescan = false, eager = true) => {
    for (const source of new Set([...cache.indexes.keys(), ...cache.pending.keys()])) {
      if (!rescan && !paths.some(path => isUnderPath(path, source) || isUnderPath(source, path))) continue;
      cache.dirty.add(source);
      if (eager && getSession().tree.expanded.has(source)) void ensure(source);
    }
  }, [cache, ensure]);

  useEffect(() => {
    if (!roots) return;
    for (const group of roots.values()) {
      for (const source of group) if (expanded.has(source) && isJavaSourceRoot(source)) void ensure(source);
    }
  }, [roots, expanded, ensure]);

  const indexes = snapshot?.epoch === epoch ? snapshot.indexes : EMPTY_INDEXES;
  return { indexes, ensure, invalidate };
}
