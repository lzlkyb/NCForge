import { useEffect, useRef } from "react";
import {
  getSession,
  setSession,
  useWorkspaceSelector,
  type Updater,
  type WorkspaceSession,
} from "../lib/workspaceSession";
import {
  compileModule,
  compileAllModules,
  compileFileOrThrow,
  isCompileCancelled,
  onCompileLog,
  type CompileResult,
} from "../lib/compile";
import { isJavaFile, mergeFileResult } from "../lib/autoCompile";
import { setAutoCompileRunner } from "../lib/autoCompileQueue";
import { runAutoCompile } from "../lib/autoCompileRun";
import { registerCommands } from "../lib/commandRegistry";
import {
  BUILTIN_TASKS,
  buildNcTaskRuntime,
  runTask,
  setTaskRuntime,
} from "../lib/ncTasks";
import { beginOperation } from "../lib/operations";
import { compileCancel } from "../lib/compile";
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
  const activePath = useWorkspaceSelector((s) => s.activePath);
  const tabs = useWorkspaceSelector((s) => s.tabs);
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

  /**
   * 一轮编译的公共流程：清日志 → 跑 → 写结果（切了工作区就丢弃）。
   *
   * 单模块与全量只有「跑哪条命令」不同，其余（未保存提醒、取消语义、日志清空、
   * 工作区切换保护）必须一模一样；各写一遍必然出现「一个会提示未保存、另一个不会」。
   *
   * `mergeFiles` 给「只编当前文件」用：那种模式下不能把整模块的结果整份替换掉
   * （`setCompileResult(null)` 会让其它文件的历史错误从问题面板消失），只能把
   * 这几个文件的问题并回去。
   */
  const start = async (
    run: () => Promise<CompileResult>,
    unsavedHint: boolean,
    mergeFiles?: readonly string[],
  ): Promise<boolean> => {
    if (getSession().compiling) { toast("已有编译在进行，请等待当前编译结束", "info"); return false; }
    const operation = beginOperation({ key: "compile.manual", label: "编译工程", scope: getSession().root ?? "工作区", page: "files", phase: "编译磁盘中的源码", cancel: compileCancel });
    if (!operation) return false;
    if (unsavedHint && tabs.some((t) => t.dirty || t.eolChanged)) {
      toast("有未保存的文件，编译读取的是磁盘版本，请先保存（Ctrl+S）", "warning");
    }
    setSession({ panelOpen: true, panelTab: "build" });
    setCompiling(true);
    if (!mergeFiles) setCompileResult(null);
    flushLog.current();
    setCompileLog([]);
    // 编译可能跑半分钟，期间用户可能切了工作区：结果不能写进新工程的面板
    const root = getSession().root ?? null;
    try {
      const r = await run();
      if ((getSession().root ?? null) !== root) {
        operation.finish("cancelled", "工程已切换，未应用旧工程的编译结果");
        return false;
      }
      // 用最新值合并：这一轮跑着的时候自动编译可能刚并进一批结果
      const merged = mergeFiles
        ? mergeFileResult(getSession().compileResult, r, mergeFiles)
        : r;
      operation.finish(r.ok ? "success" : "failed", `编译 ${r.sourceCount} 个源文件，${r.errorCount} 个错误、${r.warningCount} 个警告`);
      setCompileResult(merged);
      setSession({ panelTab: merged.errorCount > 0 ? "problems" : "build" });
      // 任务链据此决定要不要继续投送/重启：编不过就不该把旧产物推上去
      return r.ok && merged.errorCount === 0;
    } catch (e) {
      // 切工作区会顺手取消这一轮：那条 CANCELLED 属于旧工作区，别再弹一次
      if ((getSession().root ?? null) !== root) { operation.finish("cancelled", "工程已切换"); return false; }
      // 取消不是失败：不要用红色错误把用户自己的操作说成「编译失败」
      operation.finish(isCompileCancelled(e) ? "cancelled" : "failed", String(e));
      if (isCompileCancelled(e)) {
        setCompileLog((l) => [...l, "编译已取消"]);
        toast("已取消编译", "info");
      } else {
        setCompileLog((l) => [...l, `编译失败：${e}`]);
        toast(`编译失败：${e}`, "error");
      }
      return false;
    } finally {
      setCompiling(false);
    }
  };

  /** 编译当前文件所在的模块；有未保存的文件先提醒，因为 ecj 读的是磁盘上的内容。 */
  const compileActive = async (): Promise<boolean> => {
    if (!activePath || tabs.find((t) => t.path === activePath)?.virtual) {
      toast("没有打开的文件，无法编译当前模块", "warning");
      return false;
    }
    return start(() => compileModule(activePath), true);
  };

  /** 编译全部模块：不需要活动文件，所以没打开任何标签时也能用。 */
  const compileAll = async (): Promise<boolean> => {
    return start(() => compileAllModules(), true);
  };

  /**
   * 编译指定路径所属的模块（文件树右键「编译模块 X」）。
   *
   * 与 `compileActive` 的差别只有一个：不读活动标签。批量替换改完一个模块后
   * 想验证它能不能编，活动文件往往在别的模块里，那时点「编译当前模块」会编错模块
   * ——而且是静默编错（编成功了，编的不是你想的那个）。
   */
  const compilePath = async (path: string): Promise<boolean> => {
    if (!path) return false;
    return start(() => compileModule(path), true);
  };

  /**
   * 手动「编译当前文件」：只编这一个（命令面板入口）。
   *
   * 与自动编译的区别是它走 `start()`——清空并展示编译日志、切到构建 / 问题面板。
   * 用户主动点的操作就该有明确反馈；保存触发的那条则刻意什么都不碰。
   *
   * 但结果必须**合并**而不是替换：只编了一个文件，凭什么把整模块另外三百个文件的
   * 历史错误从问题面板里抹掉。
   */
  const compileActiveFile = async (): Promise<boolean> => {
    const path = activePath;
    if (!path) return false;
    // 虚拟标签（jar 内类）与 xml/properties 都没有可编的源文件。不先挡掉的话，
    // `start()` 会先把面板和日志清空，然后后端返回「跳过」，用户看到的是一句
    // 「已有一次编译在进行」——完全是另一回事。
    if (tabs.find((t) => t.path === path)?.virtual) {
      toast("这是只读的库内类，没有可编译的源文件", "warning");
      return false;
    }
    if (!isJavaFile(path)) {
      toast("只有 .java 文件能单独编译", "warning");
      return false;
    }
    return start(() => compileFileOrThrow([path]), true, [path]);
  };

  // 保存后自动编译的消费者：队列在 `lib/autoCompileQueue`（防抖 + 串行 + 被占则重排），
  // 执行在 `lib/autoCompileRun`（一批一次 IPC，后端按模块分组、每组一轮 JVM）。
  useEffect(() => {
    setAutoCompileRunner((paths) => runAutoCompile(paths));
    return () => setAutoCompileRunner(null);
  }, []);

  // 命令面板里的「编译全部模块」在这里登记：它不依赖任何页面状态，
  // 挂在文件页里反而会多传一层。闭包经 ref 取最新（effect 只跑一次）。
  const live = useRef({ compileActive, compileAll });
  live.current = { compileActive, compileAll };
  useEffect(() => {
    // 任务菜单与命令面板里的任务命令都走同一份运行时：两个编译入口来自本 hook，
    // 投送/重启/补丁在 ncTasks 里接好
    setTaskRuntime(
      buildNcTaskRuntime({
        compileActive: () => live.current.compileActive(),
        compileAll: () => live.current.compileAll(),
      }),
    );
    const off = registerCommands([
      {
        id: "build.compileAll",
        title: "编译全部模块（按依赖顺序，被依赖的先编）",
        run: () => void live.current.compileAll(),
        enabled: () => !!getSession().root && !getSession().compiling,
      },
      ...BUILTIN_TASKS.map((t) => ({
        id: `task.${t.id}`,
        title: `运行任务：${t.name}`,
        run: () => void runTask(t),
        enabled: () => !!getSession().root && !getSession().compiling,
      })),
    ]);
    return () => {
      off();
      setTaskRuntime(null);
    };
  }, []);

  return { compileActive, compileAll, compilePath, compileActiveFile };
}
