import { useCallback, useEffect, useState } from "react";
import { friendlyDbError } from "./db";
import { dbApi } from "./dbApi";
import { rtOf, setTx } from "./dbStore";

export interface DbReadOnlyState {
  /** `null` = 还没探测到（连接中 / 探测失败）。 */
  value: boolean | null;
  /** 探测失败的原因；空串 = 没有失败。探测本身不修改数据，失败可以放心重试。 */
  error: string;
  retry: () => void;
}

/**
 * 探测连接级只读状态。
 *
 * 探测失败必须留下重试入口：以前失败被吞成 `null`，界面永久停在「待验证」，
 * 只读开关被禁用、所有网格编辑也被禁用，用户没有任何办法把状态拉回来。
 */
export function useDbReadOnlyState(id: string | null): DbReadOnlyState {
  const [state, setState] = useState<{ value: boolean | null; error: string; nonce: number }>({ value: null, error: "", nonce: 0 });
  const status = rtOf(id).status;
  useEffect(() => {
    let live = true;
    setState(s => ({ ...s, value: null, error: "" }));
    if (id && status === "connected") {
      void dbApi.readOnly(id).then(
        v => { if (live) { setState(s => ({ ...s, value: v.readOnly, error: "" })); setTx(id, v.tx); } },
        e => { if (live) setState(s => ({ ...s, value: null, error: friendlyDbError(e) })); },
      );
    }
    const sync = (e: Event) => {
      const v = (e as CustomEvent<{ id: string; readOnly: boolean }>).detail;
      if (v.id === id) setState(s => ({ ...s, value: v.readOnly, error: "" }));
    };
    window.addEventListener("ncforge-db-readonly", sync);
    return () => { live = false; window.removeEventListener("ncforge-db-readonly", sync); };
  }, [id, status, state.nonce]);
  const retry = useCallback(() => setState(s => ({ ...s, nonce: s.nonce + 1 })), []);
  return { value: state.value, error: state.error, retry };
}

/** 只要布尔状态的地方仍用这个；要显示失败原因 / 重试入口的用 `useDbReadOnlyState`。 */
export function useDbReadOnly(id: string | null) {
  return useDbReadOnlyState(id).value;
}
