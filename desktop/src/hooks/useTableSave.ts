import { useCallback } from "react";
import { toast } from "../components/ui/toast";
import { friendlyDbError, parseDbError, qualifyTable, type DbError } from "../lib/db";
import { dbApi, type BoundCell, type Cell, type ColumnInfo, type ColumnMeta } from "../lib/dbApi";
import { confirmProdWrite } from "../lib/dbConfirm";
import { claimCursor, connOf, rtOf, setTx, setTxNotice, type TableTab } from "../lib/dbStore";
import { beginOperation, operationActive } from "../lib/operations";
import { dbTaskSpec, dbTxKey } from "../lib/dbOperations";
import { resultTargetIssue, type ResultExecutionContext } from "../lib/dbResultContext";
import { lookupRow, type RowChange } from "../lib/dbOptimisticEdit";
import { missingRequired } from "../lib/tableRows";
import type { ConflictValue } from "../components/db/TableDataStatus";

interface SavePage { columns: ColumnMeta[]; rows: Cell[][]; context: ResultExecutionContext; params: BoundCell[] }

/**
 * 表页「写回」的整个执行过程：生产库确认 → 逐条执行 → 冲突回读 → 结果提示。
 *
 * 从 `TableData` 抽出来的原因只有一个：组件体量门禁。里面的顺序与守卫是现场磨出来的，
 * 抽的时候保持了「一条失败就停、已成功的从待写回集合里摘掉」的原样语义。
 */
export function useTableSave({ tab, page, pk, cols, changes, sqls, drafts, readonly, txLost, onCommitted, setSaving, setPreview, setConflict, setConflictValues, setConnectionError, load }: {
  tab: TableTab;
  page: SavePage | null;
  pk: string[];
  cols: ColumnInfo[] | null;
  changes: RowChange[];
  sqls: string[];
  drafts: {
    drafts: { values: Map<number, Cell> }[];
    deleted: number[];
    pending: number;
    restoreRow: (row: number) => void;
  };
  readonly: boolean | null;
  txLost: boolean;
  /** 一条修改写回成功：把它从待写回集合里摘掉，并把内存里的行值改成新值。 */
  onCommitted: (change: RowChange) => void;
  setSaving: (value: boolean) => void;
  setPreview: (value: boolean) => void;
  setConflict: (value: string) => void;
  setConflictValues: (value: ConflictValue[]) => void;
  setConnectionError: (value: DbError | null) => void;
  load: () => Promise<void>;
}) {
  return useCallback(async () => {
    if (!page || readonly !== false || sqls.length === 0 || operationActive("db." + dbTxKey(tab.connId)) || txLost) return;
    // 新增行先做本地必填校验：直接发给数据库也能报错（ORA-01400），但那时前面的
    // 删除/修改已经执行了，用户得回滚重来。能提前挡掉的就别让它进事务。
    // 完全空白的草稿行是「还没用的模板行」——它不会生成 INSERT，也不该拦着别的写回。
    const missing = cols ? [...new Set(drafts.drafts.filter(d => d.values.size > 0).flatMap(d => missingRequired(page.columns, cols, d.values)))] : [];
    if (missing.length) { toast(`新增行还有必填列没填：${missing.join("、")}`, "warning"); return; }
    const issue = resultTargetIssue(page.context, connOf(tab.connId), rtOf(tab.connId).currentSchema ?? rtOf(tab.connId).info?.schema);
    if (issue) { toast(issue, "warning"); return; }
    const task = beginOperation(dbTaskSpec(`table.save:${tab.id}`, "写回表数据", tab.connId, tab.table, connOf(tab.connId)?.name, tab.id));
    if (!task) return;
    // 先锁页面再问生产库确认：确认框可能挂着几十秒，这期间若还能改格子，
    // 新改动不在这次 `changes` 快照里，写回成功后的 `load()` 会把它们静默清掉。
    setSaving(true);
    if (!(await confirmProdWrite(tab.id, tab.connId, sqls.join(";\n")))) { task.finish("cancelled", "未确认写回，未执行写入"); setSaving(false); return; }
    setTxNotice(tab.connId, null, undefined);
    const auto = rtOf(tab.connId).tx?.autoCommit ?? connOf(tab.connId)?.autoCommit ?? false;
    let done = 0;
    try {
      for (const change of changes) {
        task.update({ phase: `写回第 ${done + 1} / ${changes.length} 条`, progress: { done, total: changes.length } });
        claimCursor(tab.connId, null, tab.id);
        const r = await dbApi.execBound(tab.connId, change.sql, change.params, 1, 60);
        setTx(tab.connId, r.tx);
        if (r.kind !== "update" || r.updateCount !== 1) {
          const message = change.kind === "insert"
            ? "新增行写回失败：可能还有必填列没填或唯一键冲突，已停止写回。"
            : change.kind === "delete"
              ? `第 ${change.row + 1} 行在写回前已被其他人删除，删除没有命中，已停止写回。`
              : `记录 ${change.row + 1} 已变化或被删除，原值校验未通过，已停止写回。`;
          setConflict(message);
          if (change.kind !== "insert") {
            try {
              // 定位原值也用打开表页时固定的 schema，切过 schema 也不会读同名表的另一份。
              const query = lookupRow(qualifyTable(tab.schema, tab.table), page.columns, page.rows[change.row], pk);
              const latest = await dbApi.execBound(tab.connId, query.sql, query.params, 2, 60);
              if (latest.kind === "rows" && latest.rows.length === 1) {
                setConflictValues(change.cells.map(c => ({
                  name: page.columns[c.column].name,
                  before: c.before,
                  after: c.after,
                  current: latest.rows[0][latest.columns.findIndex(x => x.name.toUpperCase() === page.columns[c.column].name.toUpperCase())],
                })));
              } else setConflict(`${message} 当前主键已找不到唯一记录。`);
            } catch { setConflict(`${message} 当前记录无法读取，可重新查询核对。`); }
          }
          throw new Error(message);
        }
        if (change.kind === "update") onCommitted(change);
        else {
          // 新增/删除成功后把标记撤掉。新增是倒序执行的，移除草稿不会影响还没写回的那几条行号。
          drafts.restoreRow(change.row);
        }
        done++;
      }
      toast(auto ? `已写回 ${done} 行（自动提交）` : `已写回 ${done} 行，尚未提交——用上方事务条提交或回滚`, "success");
      // 任务记录是「发生过什么」的流水，提交之后它不会跟着变：这里只写事实，
      // 「尚未提交」交给常驻的事务条（提交/回滚后它会自己消失），否则用户回头
      // 看到一条永远停在「尚未提交」的记录，分不清是历史还是当前状态。
      task.finish("success", `已写回 ${done} 行${auto ? "（自动提交）" : ""}`);
      setPreview(false);
      await load();
    } catch (e) {
      const error = parseDbError(e);
      if (error.code === "session-lost" || error.code === "probe-failed") {
        setConnectionError(error);
        task.finish("failed", "写回已停止，请核对连接和事务结果");
        return;
      }
      const prefix = done > 0
        ? auto
          ? `第 ${done + 1} 条写回失败：${friendlyDbError(e)}（前 ${done} 条已自动提交，无法整体回滚）`
          : `第 ${done + 1} 条写回失败：${friendlyDbError(e)}（前 ${done} 条仍在未提交事务里，可回滚）`
        : `写回失败：${friendlyDbError(e)}`;
      task.finish("failed", `写回失败；前 ${done} 行${auto ? "已自动提交" : "仍在未提交事务中"}，返回表页核对`);
      toast(prefix, "error");
      // 部分已自动提交：库里的状态已经不可回滚，屏幕上的行不再代表库里的状态。
      // 强制回读当前页，宁可丢掉还没执行的那几条，也不要把假象留给用户。
      // 未自动提交时不能回读：前几条还在未提交事务里，回读看到的是旧值，
      // 而且会清掉失败那条的待写回改动，用户就没法改完再重试了。
      if (done > 0 && auto) {
        try { await load(); } catch { /* load 自己会把连接错误显示到状态条 */ }
      }
    } finally {
      setSaving(false);
    }
  }, [tab, page, pk, cols, changes, sqls, drafts, readonly, txLost, onCommitted, setSaving, setPreview, setConflict, setConflictValues, setConnectionError, load]);
}
