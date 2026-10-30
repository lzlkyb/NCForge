import { useEffect } from "react";
import { savePatchDraft } from "../lib/patchDraft";
import type { MdDraft } from "../lib/patch";

/**
 * 补丁草稿的防抖落盘（见 `lib/patchDraft`）。
 *
 * 独立成 hook 有两个原因：一是补丁页已经贴着 300 行体量门禁，二是这段逻辑
 * 有两个容易写错的依赖细节，集中在一处更好维护：
 *
 * 1. **依赖必须是原始 state，不能是现场构造的数组**。传 `[...layers]` 进去的话
 *    每次渲染都是新引用，effect 每次重跑、计时器永远重置，草稿一次都写不下去。
 * 2. **必须防抖**：`desc` 是逐键更新的，不防抖等于每敲一个字就序列化一遍
 *    整个勾选清单。
 */
export function usePatchDraftPersist(
  root: string | null,
  desc: string,
  draft: MdDraft,
  sqls: string[],
  picked: Set<string> | null,
  layers: Map<string, "hy" | "std">,
): void {
  useEffect(() => {
    const t = setTimeout(() => {
      savePatchDraft(root, {
        desc,
        draft,
        sqls,
        picked: picked ? [...picked] : null,
        layers: [...layers],
      });
    }, 400);
    return () => clearTimeout(t);
  }, [root, desc, draft, sqls, picked, layers]);
}
