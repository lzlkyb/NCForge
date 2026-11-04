import { useEffect, useRef, useState } from "react";
import { toast } from "../components/ui/toast";
import { friendlyDbError } from "./db";
import { beginOperation, cancelOperation, type OperationHandle } from "./operations";
import { dbCancelled, dbTaskSpec } from "./dbOperations";
import { connOf } from "./dbStore";
import { listen } from "./tauri";
import { ensureConnected } from "./dbConfirm";
import { dbApi, type ValueSearchOut, type ValueSearchProgress } from "./dbApi";

/** 匹配方式：0 包含 / 1 等于 / 2 开头是 / 3 结尾是。 */
export type MatchValue = 0 | 1 | 2 | 3;

/** 命中上限：到量就停，剩下的表不再扫。 */
export const MAX_HITS = 500;

export interface ValueSearchForm {
  text: string;
  mode: MatchValue;
  filter: string;
}

export type ValueSearchRun =
  | { phase: "idle" }
  | {
      phase: "running";
      /** `catalog` = 还在读表清单；`table` = 正在逐表扫。 */
      label: string;
      cancelling?:boolean;
      done: number;
      total: number;
      hits: number;
      errors: number;
    }
  | { phase: "done"; out: ValueSearchOut }
  | { phase: "error"; message: string };

/**
 * 全库按值反查的交互状态（表单 / 进度 / 取消）。UI 只管画。
 *
 * 几件事必须在这里收口：
 * - **进度事件按「连接 + 实例号」过滤**：同一连接连点两次搜索，旧那次的事件不能串进来。
 * - **关窗要取消**：关掉的只是一块界面，后端还在全表扫；不取消等于关窗后数据库继续跑。
 * - **过期的响应直接丢弃**：`searchId` 对不上就不写状态，避免后发的旧结果覆盖新结果。
 */
export function useValueSearchRun(connId: string,tabId?:string) {
  const [form, setForm] = useState<ValueSearchForm>({ text: "", mode: 0, filter: "" });
  const [run, setRun] = useState<ValueSearchRun>({ phase: "idle" });
  const searchId = useRef<number | null>(null);
  const taskRef=useRef<OperationHandle|null>(null);

  useEffect(() => {
    let dead = false;
    let un: (() => void) | undefined;
    listen<ValueSearchProgress>("db:value-search-progress", (p) => {
      if (dead || p.id !== connId || p.searchId !== searchId.current) return;
      taskRef.current?.update({phase:p.phase === "catalog" ? "读取表清单" : "逐表扫描",progress:{done:p.done,total:p.total || undefined}});
      setRun((s) =>
        s.phase !== "running"
          ? s
          : {
              phase: "running",cancelling:s.cancelling,
              // 「读取表清单」阶段 total 还是 0：说成「正在读」而不是「0/0」
              label: p.phase === "catalog" ? "读取表清单…" : `正在扫描 ${p.table ?? ""}`,
              done: p.done,
              total: p.total,
              hits: p.hits,
              errors: p.errors,
            },
      );
    })
      .then((f) => {
        if (dead) f();
        else un = f;
      })
      .catch(() => undefined);
    return () => {
      dead = true;
      un?.();
    };
  }, [connId]);

  const start = async () => {
    if(searchId.current!==null) return;
    if (!form.text.trim()) {
      toast("先填要查的值", "info");
      return;
    }
    const id = Date.now();let sent=false,stopRequested=false;
    const task=beginOperation({...dbTaskSpec(`value:${connId}`,"全库按值反查",connId,"独立查询会话",connOf(connId)?.name,tabId),phase:"检查连接",cancel:async()=>{stopRequested=true;setRun(s=>s.phase==="running" ? {...s,cancelling:true} : s);try {if(sent) await dbApi.cancelValueSearch(id);}catch(e){stopRequested=false;setRun(s=>s.phase==="running" ? {...s,cancelling:false} : s);throw e;}}});
    if(!task) {toast("这个连接仍有反查任务等待返回，请稍候", "info");return;}
    taskRef.current=task;searchId.current = id;
    setRun({ phase: "running", label: "连接数据库…", done: 0, total: 0, hits: 0, errors: 0 });
    try {
    if (!(await ensureConnected(connId))) {
      task.finish("cancelled","连接未建立，未扫描数据库");
      searchId.current = null;taskRef.current=null;
      setRun({ phase: "idle" });
      return;
    }
      if(stopRequested || searchId.current!==id) {task.finish("cancelled","扫描请求尚未发出");setRun({phase:"idle"});return;}
      sent=true;task.update({phase:"读取表清单"});
      const out = await dbApi.valueSearch({
        id: connId,
        text: form.text,
        mode: form.mode,
        tableFilter: form.filter.trim() || null,
        maxHits: MAX_HITS,
        searchId: id,
      });
      task.finish(out.canceled ? "cancelled" : out.errors.length ? "failed" : "success",`已扫描 ${out.tablesScanned} / ${out.tablesTotal} 张表，命中 ${out.hits.length} 处${out.canceled ? "，已停止" : out.truncated ? "，到达命中上限" : ""}${out.errors.length ? `，${out.errors.length} 张表读取失败` : ""}`);
      if (searchId.current !== id) return;
      setRun({ phase: "done", out });
    } catch (e) {
      task.finish(dbCancelled(e) ? "cancelled" : "failed","查询未完成，返回按值反查窗口查看原因");
      if (searchId.current !== id) return;
      setRun({ phase: "error", message: friendlyDbError(e) });
    } finally {
      if (searchId.current === id) searchId.current = null;
      if(taskRef.current===task) taskRef.current=null;
    }
  };

  const stop = () => {if(taskRef.current) void cancelOperation(taskRef.current.id);};

  /** 关窗前叫一次：还在扫就先让后端停，并让迟到的响应失效。 */
  const cancelIfRunning = () => {
    if (run.phase === "running" && searchId.current != null) {
      if(taskRef.current) void cancelOperation(taskRef.current.id);
    }
    searchId.current = null;
  };

  const patchForm = (patch: Partial<ValueSearchForm>) => setForm((f) => ({ ...f, ...patch }));

  return { form, patchForm, run, start, stop, cancelIfRunning };
}
