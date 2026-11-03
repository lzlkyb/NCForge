import { useCallback, useEffect, useRef, useState } from "react";
import { linkedProjects, type LinkedGraph } from "../lib/linkedProjects";

export interface LinkedGraphState {
  graph: LinkedGraph | null;
  error: string | null;
  loading: boolean;
  /** 上次成功读到依赖链的时间；失败时清空（旧图也一起清了）。 */
  at: number | null;
}

/**
 * 读当前工作区的依赖闭包。
 *
 * 只在切页/点「重新读取」/保存覆盖表之后拉一次——它要读盘解析每个工程的 `.classpath`，
 * 不是可以随手轮询的东西。
 *
 * 竞态用序号挡：先点「重新读取」再切工作区，两次请求会同时在路上，**晚发出的那次
 * 才作数**。没有这层保护的话先返回的旧结果会把新图覆盖掉，界面显示一个已经不存在的
 * 工作区，而用户刚点完切换会以为切换失败了。
 */
export function useLinkedGraph() {
  const [state, setState] = useState<LinkedGraphState>({ graph: null, error: null, loading: true, at: null });
  const seq = useRef(0);

  const reload = useCallback(async (root?: string) => {
    const mine = seq.current + 1;
    seq.current = mine;
    setState((s) => ({ graph: s.graph, error: null, loading: true, at: s.at }));
    try {
      const graph = await linkedProjects(root);
      if (seq.current === mine) setState({ graph, error: null, loading: false, at: Date.now() });
    } catch (e) {
      // 出错时把旧图一起清掉：留着的话用户看着上一份目录数，会以为「其实读到了」
      if (seq.current === mine) setState({ graph: null, error: String(e), loading: false, at: null });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload };
}
