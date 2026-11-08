import { useEffect, useRef, useState } from "react";
import { friendlyDbError } from "../lib/db";
import { dbApi } from "../lib/dbApi";
import { rtOf } from "../lib/dbStore";
import { confirmProdWrite } from "../lib/dbConfirm";
import { beginOperation, cancelOperation, type OperationHandle } from "../lib/operations";
import { dbTaskSpec } from "../lib/dbOperations";
import { listen } from "../lib/tauri";
import { planBlocker, type TransferPlan, type TransferRowsOut } from "../lib/transferPlan";

/** 搬运实例号：每次开搬递增，进度事件与取消都靠它区分。 */
let SEQ = 0;

export interface TransferForm {
  rightConn: string;
  owner: string;
  other: string;
  mode: "append" | "replace";
  filter: string;
  plan: TransferPlan | null;
}

export interface TransferRun {
  busy: { rows: number; canceling: boolean } | null;
  out: TransferRowsOut | null;
  err: string | null;
}

/**
 * 表 → 表 直连搬运的全部状态机。
 *
 * 表单与运行状态各用一个对象 state：这个对话框同时管「选目标 / 看映射 / 执行 / 进度 /
 * 结果 / 错误 / 取消」七件事，拆成九个独立 useState 后任何一个 setter 都要人肉记住
 * 「改了目标就要清掉旧映射和旧结果」，漏一个就会出现「换了库却按上个库的列映射搬」。
 * 合并后 `patch` 一次把相关字段一起改，状态之间不会再短暂不一致。
 */
export function useTransferRows({ connId, table, tabId, leftOwner }: {
  connId: string;
  table: string;
  tabId?: string;
  leftOwner: string;
}) {
  const [form, setForm] = useState<TransferForm>({
    rightConn: connId, owner: "", other: "", mode: "append", filter: "", plan: null,
  });
  const [run, setRun] = useState<TransferRun>({ busy: null, out: null, err: null });
  const transferRef = useRef(0);
  /** 操作中心的句柄：停止按钮走它，不能靠拼字符串找回来。 */
  const taskRef = useRef<OperationHandle | null>(null);

  const patch = (p: Partial<TransferForm>) => setForm((v) => ({ ...v, ...p }));
  const patchRun = (p: Partial<TransferRun>) => setRun((v) => ({ ...v, ...p }));
  const blocker = planBlocker(form.plan);
  const ready = !!leftOwner && !!form.owner.trim() && !!form.other.trim()
    && !blocker && !run.busy && !run.out;

  // 进度事件按实例号过滤：同一次会话里可能有别的搬运在跑
  useEffect(() => {
    let un: (() => void) | undefined;
    let dead = false;
    void listen<{ rows: number; transferId?: number }>("db:transfer-progress", (p) => {
      if (!transferRef.current) return;
      // 后端每次 emit 都带实例号：同时开两个搬运窗口时，别把对方的行数记到自己头上。
      // 老后端没有这个字段时沿用原来的行为（只认「当前有没有活动搬运」）。
      if (p.transferId != null && p.transferId !== transferRef.current) return;
      setRun((v) => (v.busy ? { ...v, busy: { ...v.busy, rows: p.rows } } : v));
    }).then((fn) => (dead ? fn() : (un = fn))).catch(() => undefined);
    return () => {
      dead = true;
      un?.();
    };
  }, []);

  /** 换目标连接：schema 跟着新连接走，旧映射与旧结果一律作废。 */
  const pick = (id: string) => {
    const rt = rtOf(id);
    patch({
      rightConn: id,
      owner: (rt.currentSchema ?? rt.info?.schema ?? "").toUpperCase(),
      plan: null,
    });
    patchRun({ out: null, err: null });
  };

  const loadPlan = async () => {
    patchRun({ err: null, out: null });
    patch({ plan: null });
    try {
      const plan = await dbApi.transferPlan(
        { id: connId, owner: leftOwner, table },
        { id: form.rightConn, owner: form.owner.trim(), table: form.other.trim() },
      );
      patch({ plan });
    } catch (e) {
      patchRun({ err: friendlyDbError(e) });
    }
  };

  const start = async () => {
    if (!ready) return;
    const target = `${form.owner.trim()}.${form.other.trim()}`;
    const head = form.mode === "replace"
      ? `-- 清空 ${target} 并写入 ${table} 的数据`
      : `-- 向 ${target} 追加 ${table} 的数据`;
    if (!(await confirmProdWrite(tabId ?? connId, form.rightConn, head))) return;
    const id = (SEQ += 1);
    transferRef.current = id;
    const task = beginOperation({
      ...dbTaskSpec(`move:${connId}:${table}:${target}`, "搬运表数据", connId,
        `${table} → ${target}`, undefined, tabId),
      cancel: async () => {
        setRun((v) => (v.busy ? { ...v, busy: { ...v.busy, canceling: true } } : v));
        await dbApi.cancelTransferRows(id);
      },
    });
    if (!task) return;
    taskRef.current = task;
    patchRun({ busy: { rows: 0, canceling: false }, err: null });
    try {
      const res = await dbApi.transferRows({
        from: { id: connId, owner: leftOwner, table },
        to: { id: form.rightConn, owner: form.owner.trim(), table: form.other.trim() },
        filter: form.filter.trim() || null,
        mode: form.mode,
        transferId: id,
      });
      patchRun({ out: res });
      task.finish(res.canceled ? "cancelled" : "success", `已搬 ${res.copied} 行，${res.batches} 批`);
    } catch (e) {
      // 已经提交的批留在目标库里：错误文案里不能让人以为「什么都没写进去」
      patchRun({ err: friendlyDbError(e) });
      task.finish("failed", "搬运中断；已提交的批次不会回滚，回目标表核实行数");
    } finally {
      transferRef.current = 0;
      taskRef.current = null;
      patchRun({ busy: null });
    }
  };

  const stop = () => {
    if (taskRef.current) void cancelOperation(taskRef.current.id);
  };

  return { form, run, ready, blocker, patch, pick, loadPlan, start, stop };
}
