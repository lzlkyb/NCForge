import { useEffect, useState } from "react";
import type { SourceCheck } from "../lib/db";

/**
 * 补丁页的出包确认状态机：表结构核对结果 + 「表不存在」的二次确认。
 *
 * 为什么把这几个 state 攥在一起：`check`（核对结果）和 `armed`（确认态）
 * 同生共死——勾选一变，上次的核对结果就不作数了，不能拿旧结果给新一批
 * 文件背书，确认态自然也要跟着清零。散在页面里就要靠两条 effect 手工同步，
 * 迟早出现「结果换了、确认态还在」这种半新半旧的状态。
 *
 * @param chosenKey 勾选文件的指纹（路径拼串）。它一变就重置整台状态机。
 */
export function useCheckGuard(chosenKey: string) {
  /** 核对的最近一次结果。父级拿「表不存在」的个数给出包按钮加标记。 */
  const [check, setCheck] = useState<SourceCheck | null>(null);
  /** 「有表不存在」时点第一次只把按钮变成确认态，第二次才真出包。 */
  const [armed, setArmed] = useState(false);

  // 勾选一变，上次的核对结果就不作数了——不能拿旧结果给新的一批文件背书
  useEffect(() => {
    setCheck(null);
    setArmed(false);
  }, [chosenKey]);

  const tablesMissing = check?.missingTables ?? 0;
  return { check, setCheck, armed, setArmed, tablesMissing };
}
