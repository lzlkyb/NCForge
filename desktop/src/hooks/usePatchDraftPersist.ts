import { useEffect, useRef } from "react";
import { savePatchDraft, type PatchDraft } from "../lib/patchDraft";
import type { MdDraft } from "../lib/patch";

/**
 * 补丁草稿的防抖落盘（见 `lib/patchDraft`）。
 *
 * 独立成 hook 有两个原因：一是补丁页已经贴着 300 行体量门禁，二是这段逻辑
 * 有几个容易写错的依赖细节，集中在一处更好维护：
 *
 * 1. **依赖必须是原始 state，不能是现场构造的数组**。传 `[...layers]` 进去的话
 *    每次渲染都是新引用，effect 每次重跑、计时器永远重置，草稿一次都写不下去。
 * 2. **必须防抖**：`desc` 是逐键更新的，不防抖等于每敲一个字就序列化一遍
 *    整个勾选清单。
 * 3. **卸载时要补一次**：防抖窗口内切页 / 切工程，计时器被清掉，最后 400ms
 *    的改动会凭空消失。所以用 ref 留一份最新值，在卸载时同步写盘。
 *    切换工程时组件按 root 换 key 重挂载，这份补写落在**旧**工作区的键上。
 */
export function usePatchDraftPersist(
  root: string | null,
  desc: string,
  draft: MdDraft,
  sqls: string[],
  picked: Set<string> | null,
  layers: Map<string, "hy" | "std">,
): void {
  const latest = useRef<PatchDraft>({ desc, draft, sqls, picked: null, layers: [] });
  latest.current = {
    desc,
    draft,
    sqls,
    picked: picked ? [...picked] : null,
    layers: [...layers],
  };

  useEffect(() => {
    const t = setTimeout(() => savePatchDraft(root, latest.current), 400);
    return () => clearTimeout(t);
  }, [root, desc, draft, sqls, picked, layers]);

  useEffect(() => {
    // 只在卸载时读 ref：不能并进上面那个 effect 的清理函数，否则每次依赖变化
    // 都会立刻写一次，防抖就失效了。
    return () => savePatchDraft(root, latest.current);
  }, [root]);
}
