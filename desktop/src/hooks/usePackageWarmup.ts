import { useEffect } from "react";
import { isJavaSourceRoot, sourceForPath, type PackageRoots } from "../lib/packageTree";
import { useViewActive } from "../lib/viewActivity";

const WARM_ROOTS = 8;

/** Let the first tree paint finish and warm just one likely source root at a time. */
export function usePackageWarmup(root: string, roots: PackageRoots | undefined, activePath: string | null, prepare: (path: string) => Promise<void>) {
  const active = useViewActive();
  const activeSource = activePath ? sourceForPath(roots, activePath) : undefined;
  useEffect(() => {
    if (!active || !roots) return;
    const targets = [...new Set([...(activeSource ? [activeSource] : []), ...(roots.get(root) ?? []).filter(isJavaSourceRoot)])].slice(0, WARM_ROOTS);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idle: number | undefined;
    let cursor = 0;
    const schedule = (delay: number) => {
      if (disposed || cursor >= targets.length) return;
      timer = setTimeout(() => {
        const run = () => {
          if (disposed) return;
          const next = () => schedule(45);
          void prepare(targets[cursor++]).then(next, next);
        };
        if (window.requestIdleCallback) idle = window.requestIdleCallback(run);
        else run();
      }, delay);
    };
    schedule(180);
    return () => {
      disposed = true;
      clearTimeout(timer);
      if (idle !== undefined) window.cancelIdleCallback?.(idle);
    };
  }, [active, activeSource, root, roots, prepare]);
}
