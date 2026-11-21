import { useRef, useState } from "react";
import { planImport, type Mapping, type TargetCol } from "../lib/csvImport";
import type { ParsedRows } from "../lib/csvParse";
import { dbApi, type ImportFail } from "../lib/dbApi";
import { confirmProdWrite } from "../lib/dbConfirm";
import { friendlyDbError } from "../lib/db";
import { beginOperation, cancelOperation, type OperationHandle } from "../lib/operations";
import { dbTaskSpec } from "../lib/dbOperations";

/** 一批多少行。太小则往返多，太大则一条命令里全是拼出来的 SQL。 */
export const BATCH = 200;

/** 导入进行到哪一步。`canceling` 并进来是因为它本来就是「这一轮的状态」的一部分。 */
export interface ImportBusy {
  inserted: number;
  total: number;
  canceling: boolean;
}

/** 导入结果摘要：即使中途抛错也会给（已写入的批不会因为异常消失）。 */
export interface ImportResult {
  inserted: number;
  failed: ImportFail[];
  ms: number;
  canceled: boolean;
  /**
   * 有失败明细被后端截断（每批最多回 [`MAX_FAILS`] 条）。
   *
   * 必须带出来：失败 5000 行时界面说「失败 5000 行」却只导得出几百条明细，
   * 用户会当成导出坏了，或者更糟——以为坏行只有这些。
   */
  truncated: boolean;
}

/**
 * 导入的执行段：分批写库、取消、结果汇总。
 *
 * 三条被测试钉住的语义（`ImportDialog.test.tsx`）：
 * ① 点取消必须**立刻**有反馈，但只在**批间**生效——正在飞的那批必须写完，
 *    请求已经发出去了，不知道结果就停等于丢数据；
 * ② 中途抛错也要报出已写入行数，已写的批不会因为异常消失；
 * ③ 导入结束后不允许再点：同一份文件再导一遍就是整批重复数据。
 *
 * 从组件里拆出来是因为 `ImportDialog.tsx` 已经用满 8 个 useState+useEffect
 * 的体量门禁额度（2026-11-17），再加功能只能进 hook。
 */
export function useImportRun(opts: {
  connId: string;
  table: string;
  tabId?: string;
  parsed: ParsedRows | null;
  target: TargetCol[] | null;
  picked: Mapping[];
  skip: boolean;
  /** 目标列下标 → 日期格式预设键；没有就按 ISO 口径。 */
  fmtOf?: (to: number) => string | undefined;
  setErr: (v: string | null) => void;
  reveal: () => void;
}) {
  const { connId, table, tabId, parsed, target, picked, skip, fmtOf, setErr, reveal } = opts;
  const [busy, setBusy] = useState<ImportBusy | null>(null);
  const [out, setOut] = useState<ImportResult | null>(null);
  /** 取消只置标志：正在飞的那一批必须写完，否则请求发出去了却不知道结果。 */
  const cancelRef = useRef(false);
  const taskRef = useRef<OperationHandle | null>(null);

  const run = async () => {
    if (!parsed || !target || picked.length === 0 || taskRef.current || out) return;
    // 生产库写入必须二次确认，且带着目标表与行数；导入按批独立提交，落库后只剩人工收拾。
    const prodText = `-- 导入 ${parsed.rows.length} 行到 ${table}（${picked.length} 列）`;
    if (!(await confirmProdWrite(tabId ?? connId, connId, prodText))) return;
    const spec = dbTaskSpec(`import:${connId}:${table}`, "导入表数据", connId, `${table} · 独立导入会话`, undefined, tabId);
    const task = beginOperation({
      ...spec,
      reveal: () => { spec.reveal?.(); reveal(); },
      cancel: async () => {
        cancelRef.current = true;
        setBusy((v) => (v ? { ...v, canceling: true } : v));
      },
    });
    if (!task) return;
    taskRef.current = task;
    setErr(null);
    setOut(null);
    // 切批与行号换算是纯函数（lib/csvImport），这里只管发请求与报进度
    const plan = planImport(parsed, target, picked, BATCH, fmtOf);
    let inserted = 0;
    const failed: ImportFail[] = [];
    let truncated = false;
    const t0 = Date.now();
    let stopped = false;
    let rolledBack = false;
    cancelRef.current = false;
    setBusy({ inserted: 0, total: parsed.rows.length, canceling: false });
    try {
      for (const ch of plan.chunks) {
        if (cancelRef.current) {
          stopped = true;
          break;
        }
        const res = await dbApi.importRows({
          id: connId,
          table,
          columns: plan.columns,
          rows: ch.rows,
          startLine: ch.startLine,
          skipErrors: skip,
        });
        inserted += res.inserted;
        failed.push(...res.failed);
        truncated ||= res.truncated;
        setBusy({
          inserted,
          total: parsed.rows.length,
          canceling: cancelRef.current,
        });
        task.update({
          phase: "每批独立提交",
          progress: { done: inserted, total: parsed.rows.length, unit: "行已提交" },
        });
        if (!res.committed) {
          rolledBack = true;
          break; // 遇错停：这一批已回滚，后面的不再试
        }
      }
      task.finish(
        stopped ? (inserted ? "partial" : "cancelled") : failed.length || rolledBack ? (inserted ? "partial" : "failed") : "success",
        `已写入 ${inserted} 行，失败 ${failed.length} 行${stopped ? "；已在批次边界停止" : rolledBack ? "；当前批已回滚" : ""}`,
      );
      setOut({ inserted, failed, truncated, ms: Date.now() - t0, canceled: stopped });
    } catch (e) {
      task.finish("failed", `导入中断；前 ${inserted} 行已写入，返回导入窗口核对`);
      // 已经写进去的批不会因为异常消失：进度摘要照给，错误另显示。
      // 少这一行的话，用户点过取消后又遇错，界面只剩一条错误，「到底写了多少」没人知道。
      setOut({ inserted, failed, truncated, ms: Date.now() - t0, canceled: false });
      setErr(friendlyDbError(e));
    } finally {
      taskRef.current = null;
      setBusy(null);
    }
  };

  /** 取消：只置标志，当前批写完再停（点完要立刻有反馈，所以先切 canceling）。 */
  const cancel = () => {
    if (taskRef.current) void cancelOperation(taskRef.current.id);
  };

  return { busy, out, run, cancel };
}
