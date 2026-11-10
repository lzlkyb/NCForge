import { useSyncExternalStore } from "react";

/**
 * 提交 / 回滚的「纪元」：按 连接 + 会话槽 记录最近一次事务动作。
 *
 * 为什么需要它：事务条的动作只改后端会话，屏幕上的表页和结果网格并不知道
 * 刚才那次回滚把已经写进去的值又撤掉了，用户会基于「已改好」的假象继续操作。
 * 网格订阅这个纪元，回滚后清掉本地覆盖、表页自动回读。
 *
 * 用 `seq` 而不是时间戳做判据：同一毫秒内连续两次动作也不能被漏掉。
 */
export interface TxEpoch {
  seq: number;
  action: "commit" | "rollback";
  at: number;
}

const EMPTY: TxEpoch = { seq: 0, action: "commit", at: 0 };
const epochs = new Map<string, TxEpoch>();
const listeners = new Set<() => void>();
const keyOf = (connId: string | null, slot?: string | null) => `${connId ?? ""}#${slot || "primary"}`;

export function bumpTxEpoch(connId: string | null, slot: string | null | undefined, action: TxEpoch["action"]) {
  if (!connId) return;
  const key = keyOf(connId, slot);
  const cur = epochs.get(key) ?? EMPTY;
  epochs.set(key, { seq: cur.seq + 1, action, at: Date.now() });
  listeners.forEach(fn => fn());
}

export function txEpochOf(connId: string | null, slot?: string | null): TxEpoch {
  return epochs.get(keyOf(connId, slot)) ?? EMPTY;
}

export function useTxEpoch(connId: string | null, slot?: string | null): TxEpoch {
  return useSyncExternalStore(
    fn => { listeners.add(fn); return () => listeners.delete(fn); },
    () => txEpochOf(connId, slot),
    () => EMPTY,
  );
}

/** 测试用：清掉跨用例的残留。 */
export function __resetTxEpochForTest() {
  epochs.clear();
  listeners.forEach(fn => fn());
}
