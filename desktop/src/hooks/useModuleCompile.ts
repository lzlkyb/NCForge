import { useEffect } from "react";
import {
  getSession,
  setSession,
  useWorkspaceSession,
  type Updater,
  type WorkspaceSession,
} from "../lib/workspaceSession";
import { compileModule, isCompileCancelled, onCompileLog } from "../lib/compile";
import { toast } from "../components/ui/toast";

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

  // 编译过程的逐行进度（首次建类索引时较久，靠它让界面有反馈）。
  // 切页期间这个订阅会断，期间的日志行收不到，但最终结果写回仓库，回来仍然可见。
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void onCompileLog((line) => setCompileLog((l) => [...l, line])).then((f) => {
      // listen 握手是异步的：resolve 前就卸载的话，拿到的取消函数没人调，
      // 每挂载一次就多留一个监听，编译日志行会成倍重复。
      if (cancelled) f();
      else off = f;
    });
    return () => {
      cancelled = true;
      off?.();
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
