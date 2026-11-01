import { useEffect, useRef } from "react";
import {
  getSession,
  setSession,
  useWorkspaceSession,
  type Updater,
  type WorkspaceSession,
} from "../lib/workspaceSession";
import { compileModule, isCompileCancelled, onCompileLog } from "../lib/compile";
import { toast } from "../components/ui/toast";

/** 日志攒多久刷一次：逐行 setSession 会让整个会话订阅者（含 Monaco 外的面板）每行重渲染。 */
const LOG_FLUSH_MS = 80;
/** 一次编译的日志上限。够定位问题，又不至于把几万行塞进 DOM。 */
const LOG_MAX_LINES = 5000;
const LOG_TRUNCATED = `日志太长，只保留最近 ${LOG_MAX_LINES} 行`;

function appendLog(prev: string[], batch: string[]): string[] {
  const next = prev.concat(batch);
  if (next.length <= LOG_MAX_LINES) return next;
  // 提示行永远在最上面，且只有一条（滚动窗口里可能还留着上一次的提示）
  const tail = next.slice(-(LOG_MAX_LINES - 1)).filter((l) => l !== LOG_TRUNCATED);
  return [LOG_TRUNCATED, ...tail];
}

/**
 * 「编译当前模块」+ 编译日志订阅。
 *
 * 从 `FilesTab` 抽出来：编译是有状态的流程（跑起来了 / 结果 / 逐行日志），
 * 混在接线组件里会把行数和 hook 数顶爆（组件体量门禁：≤300 行、≤8 个 useState/useEffect）。
 * 状态本身还在 `lib/workspaceSession`（切页不该丢），这里只放动作与订阅。
 */
export function useModuleCompile() {
  const { activePath, tabs } = useWorkspaceSession();
  const setCompiling = (v: Updater<boolean>) => setSession({ compiling: v });
  const setCompileResult = (v: Updater<WorkspaceSession["compileResult"]>) =>
    setSession({ compileResult: v });
  const setCompileLog = (v: Updater<string[]>) => setSession({ compileLog: v });
  /** 立刻把攒着的日志刷进会话（开始新一轮编译前必须调，否则旧行会混进新日志）。 */
  const flushLog = useRef<() => void>(() => {});

  // 编译过程的逐行进度（首次建类索引时较久，靠它让界面有反馈）。
  // 切页期间这个订阅会断，期间的日志行收不到，但最终结果写回仓库，回来仍然可见。
  //
  // 后端一行一条事件，这里攒 80ms 再一次性写会话：逐行 setSession 会让每个订阅者
  // （文件树、标签栏、面板）为每一行重渲染一次，几千行日志时肉眼可见地卡。
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    let pending: string[] = [];
    let timer: number | null = null;
    const flush = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      setCompileLog((l) => appendLog(l, batch));
    };
    flushLog.current = flush;
    void onCompileLog((line) => {
      pending.push(line);
      if (timer === null) timer = window.setTimeout(flush, LOG_FLUSH_MS);
    }).then((f) => {
      // listen 握手是异步的：resolve 前就卸载的话，拿到的取消函数没人调，
      // 每挂载一次就多留一个监听，编译日志行会成倍重复。
      if (cancelled) f();
      else off = f;
    });
    return () => {
      cancelled = true;
      off?.();
      flushLog.current = () => {};
      // 卸载时把攒的写回仓库：用户切页回来日志要完整
      flush();
    };
  }, []);

  /** 编译当前文件所在的模块；有未保存的文件先提醒，因为 ecj 读的是磁盘上的内容。 */
  const compileActive = async () => {
    if (!activePath || tabs.find((t) => t.path === activePath)?.virtual) return;
    if (tabs.some((t) => t.dirty || t.eolChanged)) {
      toast("有未保存的文件，编译读取的是磁盘版本，请先保存（Ctrl+S）", "warning");
    }
    setSession({ panelOpen: true, panelTab: "build" });
    setCompiling(true);
    setCompileResult(null);
    flushLog.current();
    setCompileLog([]);
    // 编译可能跑半分钟，期间用户可能切了工作区：结果不能写进新工程的面板
    const root = getSession().root ?? null;
    try {
      const r = await compileModule(activePath);
      if ((getSession().root ?? null) !== root) {
        setCompileLog((l) => [...l, "编译结果属于上一个工作区，已丢弃"]);
        return;
      }
      setCompileResult(r);
      setSession({ panelTab: r.errorCount > 0 ? "problems" : "build" });
    } catch (e) {
      // 切工作区会顺手取消这一轮：那条 CANCELLED 属于旧工作区，别再弹一次
      if ((getSession().root ?? null) !== root) return;
      // 取消不是失败：不要用红色错误把用户自己的操作说成「编译失败」
      if (isCompileCancelled(e)) {
        setCompileLog((l) => [...l, "编译已取消"]);
        toast("已取消编译", "info");
      } else {
        setCompileLog((l) => [...l, `编译失败：${e}`]);
        toast(`编译失败：${e}`, "error");
      }
    } finally {
      setCompiling(false);
    }
  };

  return { compileActive };
}
