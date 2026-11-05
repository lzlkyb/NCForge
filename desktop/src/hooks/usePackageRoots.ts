import { useEffect, useState } from "react";
import { loadPackageRoots, type PackageRoots } from "../lib/packageTree";

export function usePackageRoots(roots: string[], expanded: ReadonlySet<string>, enabled: boolean): PackageRoots | undefined {
  const signature = roots.join("|");
  const open = enabled ? roots.filter(r => expanded.has(r)).join("|") : "";
  const [cache, setCache] = useState<{ signature: string; roots: PackageRoots }>();
  useEffect(() => {
    if (!open) return;
    let alive = true;
    // One project at a time; the resolver bounds concurrent directory reads within it.
    void (async () => {
      for (const root of open.split("|")) {
        if (!alive) return;
        const found = await loadPackageRoots(root).catch(() => []);
        if (alive) setCache(prev => ({ signature, roots: new Map([...(prev?.signature === signature ? prev.roots : []), [root, found]]) }));
      }
    })();
    return () => { alive = false; };
  }, [open, signature]);
  return enabled && cache?.signature === signature ? cache.roots : undefined;
}
