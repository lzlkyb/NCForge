import { useCallback, useRef, useState } from "react";
import { trackOperation } from "../lib/operations";
import { upmIndex, type UpmReport } from "../lib/upm";

/**
 * 「UPM 装配」检查的状态机。
 *
 * 与 `useArtifactCheck` 同构，两个关键差别：
 * - **两种深度**：默认只扫 upm 与工程源码（快），`deep` 才去动类索引（首次 10~100 秒）。
 *   把「这次查到什么程度」记在 state 里，界面必须能把「没查全」说出来。
 * - **结果带指纹**：upm 属于工作区，切了工作区结论就不成立（标记 stale，不清空）。
 */

export interface UpmCheckState {
  running: boolean;
  /** 本次是否走的深度校验 */
  deep: boolean;
  error: string | null;
  report: UpmReport | null;
  /** 跑这次时的工程根，用来判断结果还成不成立 */
  stamp: string | null;
  elapsedMs: number | null;
}

const EMPTY: UpmCheckState = {
  running: false,
  deep: false,
  error: null,
  report: null,
  stamp: null,
  elapsedMs: null,
};

export function useUpmCheck(stamp: string, root: string | null) {
  const [state, setState] = useState<UpmCheckState>(EMPTY);
  /** 请求序号：只认最后一次点击，挡住「旧请求后回来」 */
  const seq = useRef(0);

  const run = useCallback(
    async (opts: { deep?: boolean; refresh?: boolean } = {}) => {
      const deep = opts.deep ?? false;
      const mine = ++seq.current;
      setState((s) => ({ ...s, running: true, deep, error: null }));
      const started = Date.now();
      try {
        const report = await trackOperation({ key: `upm.check:${root}:${deep}`, label: deep ? "完整检查 UPM 装配" : "检查 UPM 装配", scope: root ?? "工作区", page: "linked", phase: deep ? "建立类索引并验证接口与实现" : "读取工程装配表" }, () => upmIndex({ root, deep, refresh: opts.refresh ?? false }), r => ({ state: "success", detail: `${r.issues.length} 项诊断${r.classCheckComplete ? "；类存在性已完整检查" : "；类存在性未查全，缺失类暂不下结论"}` }));
        if (seq.current !== mine) return;
        setState({
          running: false,
          deep,
          error: null,
          report,
          stamp,
          elapsedMs: Date.now() - started,
        });
      } catch (e) {
        if (seq.current !== mine) return;
        // 失败时保留旧结论只会让人分不清哪份是真的，清掉并说原因
        setState({ ...EMPTY, error: String(e) });
      }
    },
    [root, stamp],
  );

  const reset = useCallback(() => setState(EMPTY), []);

  return {
    ...state,
    /** 结果还在，但工作区已经换了 ⇒ 结论不再成立 */
    stale: state.report !== null && state.stamp !== stamp,
    run,
    reset,
  };
}
