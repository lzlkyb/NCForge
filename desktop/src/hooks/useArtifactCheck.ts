import { useCallback, useRef, useState } from "react";
import { trackOperation } from "../lib/operations";
import { checkArtifacts } from "../lib/linkedProjects";
import type { CompileDiagnostic } from "../lib/compile";

/**
 * 「检查产物」（D4 的全量新旧检测）的状态机。
 *
 * 为什么要有这个 hook 而不是在组件里 `await checkArtifacts()`：
 * 这个操作**要跑 8~22 秒**（真机三工程 149k 个目录条目，见 `check_artifacts` 的注释），
 * 期间用户会去点别的按钮、改覆盖表、点「重新读取」。三件事都得处理对：
 *
 * 1. **竞态**：点了两次或重读链之后又点，先发的请求可能后回来 —— 用序号挡掉旧的。
 * 2. **过期**：结果是对**检查那一刻的依赖链**说的。链变了（保存覆盖表、切工作区）
 *    结论就不再成立，但直接把结果丢掉会让用户以为「点了没反应」⇒ 标记 `stale`，
 *    界面显示「基于上一次的依赖链」并提示重查。
 * 3. **耗时**：把实际用了多久带回去显示。用户等 15 秒和等 2 秒的心理预期完全不同，
 *    与其藏起来不如摊开说。
 */

export interface ArtifactCheckState {
  running: boolean;
  error: string | null;
  result: CompileDiagnostic[] | null;
  /** 检查时的依赖链签名（名字 + 目录数 + 停用状态，见调用方的 `chainStamp`） */
  stamp: string | null;
  /** 上次检查实际耗时（毫秒），没跑过是 null */
  elapsedMs: number | null;
}

const EMPTY: ArtifactCheckState = {
  running: false,
  error: null,
  result: null,
  stamp: null,
  elapsedMs: null,
};

export function useArtifactCheck(chainStamp: string, root: string | null) {
  const [state, setState] = useState<ArtifactCheckState>(EMPTY);
  /** 请求序号：只认最后一次点击的结果，挡「旧请求后回来」把新结果覆盖掉 */
  const seq = useRef(0);

  const run = useCallback(async () => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, running: true, error: null }));
    const started = Date.now();
    try {
      // 显式指定主工程根：检查的必须是**眼前这条链**，而不是配置里可能过期的
      // `workspace_root`（用户在别处改过配置、这页还没重读时两者会不一致）
      const result = await trackOperation({ key: `artifacts.check:${root}`, label: "检查工程编译产物", scope: root ?? "工程依赖链", page: "linked", phase: "对照源码与 class 的更新时间" }, () => checkArtifacts(root ?? undefined), r => ({ state: "success", detail: `${r.length} 项诊断；结果基于本次工程依赖链` }));
      if (seq.current !== mine) return;
      setState({
        running: false,
        error: null,
        result,
        stamp: chainStamp,
        elapsedMs: Date.now() - started,
      });
    } catch (e) {
      if (seq.current !== mine) return;
      // 失败时保留上一次的结果没有意义（不知道它对不对），清掉并说清原因
      setState({ ...EMPTY, error: String(e) });
    }
  }, [chainStamp, root]);

  const reset = useCallback(() => setState(EMPTY), []);

  return {
    ...state,
    /** 结果还在，但依赖链已经变了 ⇒ 结论不再成立 */
    stale: state.result !== null && state.stamp !== chainStamp,
    run,
    reset,
  };
}
