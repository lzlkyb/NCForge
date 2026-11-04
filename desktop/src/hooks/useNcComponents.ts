import { useCallback, useEffect, useState } from "react";
import { baseName, dirName } from "../lib/workspace";
import {
  EMPTY_INDEX,
  bcBadge,
  type ComponentIndex,
  loadNcManifest,
  mergeIndexes,
} from "../lib/ncManifest";

export interface NcComponents {
  /** 小写组件名 → 徽章提示里的名字。空 Map = 没有 manifest / 读失败。 */
  bcNames: ComponentIndex;
  /** 这个目录是不是「工程根下的业务组件模块」（徽章与 NC 结构视图都问它）。 */
  isBcModule: (dir: string) => boolean;
  /** 这一层的子目录要不要摊平 `src`（NC 结构视图；开关关着或不是组件时为 false）。 */
  hoist: (dir: string) => boolean;
}

/**
 * 各工程根的业务组件索引（`manifest.xml`），给树的模块行打徽章、并决定
 * NC 结构视图要不要把 `src` 摊平。
 *
 * 多工程树里每个工程各有自己的 manifest，逐个取再合并：同名模块（两个工程都有 `bill`）
 * 保留先到的那份，结果对徽章语义没有影响——「这个目录是业务组件」是就地成立的。
 *
 * 取不到就是空索引：manifest 不是树的真源，它坏了不能让树空着，更不能少显示模块。
 */
export function useNcComponents(roots: string[], ncStructure: boolean): NcComponents {
  // 依赖键用拼串而不是数组本身：数组引用一变就重取，而 manifest 的变化频率是「换工程」级别。
  const key = roots.filter(Boolean).join("|");
  const [index, setIndex] = useState<ComponentIndex>(EMPTY_INDEX);

  useEffect(() => {
    const list = key ? key.split("|") : [];
    if (list.length === 0) {
      setIndex(EMPTY_INDEX);
      return;
    }
    let alive = true;
    void Promise.all(list.map(loadNcManifest)).then((all) => {
      if (alive) setIndex(mergeIndexes(all));
    });
    return () => {
      alive = false;
    };
  }, [key]);

  /**
   * 判据 = 父目录是某个工程根 + 名字在 manifest 里登记过。
   *
   * 只看名字的话，`com/aier/bill` 这种深层同名目录也会被误标（树里真的有 `gl/bill`）。
   */
  const isBcModule = useCallback(
    (dir: string): boolean => {
      if (index.size === 0) return false;
      if (!roots.some((r) => r.toLowerCase() === dirName(dir).toLowerCase())) return false;
      return bcBadge(baseName(dir), index) !== undefined;
    },
    [index, roots],
  );

  const hoist = useCallback(
    (dir: string) => ncStructure && isBcModule(dir),
    [ncStructure, isBcModule],
  );

  return { bcNames: index, isBcModule, hoist };
}
