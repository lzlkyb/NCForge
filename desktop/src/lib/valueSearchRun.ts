import { useEffect, useRef, useState } from "react";
import { toast } from "../components/ui/toast";
import { friendlyDbError } from "./db";
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
export function useValueSearchRun(connId: string) {
  const [form, setForm] = useState<ValueSearchForm>({ text: "", mode: 0, filter: "" });
  const [run, setRun] = useState<ValueSearchRun>({ phase: "idle" });
  const searchId = useRef<number | null>(null);

  useEffect(() => {
    let dead = false;
    let un: (() => void) | undefined;
    listen<ValueSearchProgress>("db:value-search-progress", (p) => {
      if (dead || p.id !== connId || p.searchId !== searchId.current) return;
      setRun((s) =>
        s.phase !== "running"
          ? s
          : {
              phase: "running",
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
    if (!form.text.trim()) {
      toast("先填要查的值", "info");
      return;
    }
    const id = Date.now();
    searchId.current = id;
    setRun({ phase: "running", label: "连接数据库…", done: 0, total: 0, hits: 0, errors: 0 });
    if (!(await ensureConnected(connId))) {
      searchId.current = null;
      setRun({ phase: "idle" });
      return;
    }
    try {
      const out = await dbApi.valueSearch({
        id: connId,
        text: form.text,
        mode: form.mode,
        tableFilter: form.filter.trim() || null,
        maxHits: MAX_HITS,
        searchId: id,
      });
      if (searchId.current !== id) return;
      setRun({ phase: "done", out });
    } catch (e) {
      if (searchId.current !== id) return;
      setRun({ phase: "error", message: friendlyDbError(e) });
    } finally {
      if (searchId.current === id) searchId.current = null;
    }
  };

  const stop = () => {
    const id = searchId.current;
    if (id == null) return;
    void dbApi
      .cancelValueSearch(id)
      .then(() => toast("正在停下（当前这条查询会被打断）", "info"))
      .catch((e) => toast(`取消失败：${friendlyDbError(e)}`, "error"));
  };

  /** 关窗前叫一次：还在扫就先让后端停，并让迟到的响应失效。 */
  const cancelIfRunning = () => {
    if (run.phase === "running" && searchId.current != null) {
      void dbApi.cancelValueSearch(searchId.current).catch(() => undefined);
    }
    searchId.current = null;
  };

  const patchForm = (patch: Partial<ValueSearchForm>) => setForm((f) => ({ ...f, ...patch }));

  return { form, patchForm, run, start, stop, cancelIfRunning };
}
