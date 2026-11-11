import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "../components/ui/toast";
import { friendlyDbError, isLobPreview, sameCell } from "../lib/db";
import { dbApi, type Cell, type ColumnMeta } from "../lib/dbApi";
import { confirmProdWrite } from "../lib/dbConfirm";
import type { RowChange } from "../lib/dbOptimisticEdit";
import { editableCellType } from "../lib/sqlEditable";
import { rowsWithDrafts } from "../lib/tableRows";
import { patchTab, setTx, setTxNotice, type SqlTab } from "../lib/dbStore";
import { useRowDrafts } from "./useRowDrafts";
import { useResultSetPlan } from "./useResultSetPlan";
import { useTxEpoch } from "../lib/dbTxEpoch";
import { useResultSetEditModel } from "./useResultSetEditModel";
import { binaryRowSql } from "../lib/tableLob";
import type { GridEdit } from "../components/db/gridEdit";

/**
 * SQL 控制台结果页的「直接改数据」。
 *
 * 与表页共用同一套写回口径（`optimisticChanges` + 原值守卫 + 生产库确认），
 * 差别只在定位方式：表页知道自己查的是哪张表，而这里要先从 SQL 判断。
 * 判断不成立时**照样把原因返回给界面**——用户需要知道为什么双击没反应。
 *
 * 行级增删与表页同一套虚拟行号口径：`rows.length + i` 是第 i 条新增草稿行，
 * `deleted` 里放真实行号（只标记，写回时才真的删）。写回成功的值就地覆盖
 * 显示行（`applied`），不回写 store——结果集是执行时的一次快照，
 * 改了就与「再执行一次会看到什么」分叉。
 */
export function useResultSetEdit({ tabId, connId, slot, sql, columns, rows, schema }: {
  tabId: string;
  connId: string | null;
  slot?: string | null;
  sql: string;
  columns: ColumnMeta[];
  rows: Cell[][];
  /** 执行这条 SQL 时的默认 schema；写回与表结构读取都用它限定，之后切 schema 也不会串表。 */
  schema?: string;
}) {
  const model = useResultSetEditModel({ connId, sql, schema, columns });
  const { tableRef, rowidCol, sourceName, twinsOf, keyInfo, usable, blocked } = model;
  const [changed, setChanged] = useState<Map<string, Cell>>(new Map());
  /** 写回成功后更新的值：`行:列` → 新值。基准是数据库快照，不是屏幕上被草稿行改过的行。 */
  const [applied, setApplied] = useState<Map<string, Cell>>(new Map());
  // 回滚把已经写进库的值撤掉了：本地那份「写回后的值」不能再当基准，
  // 否则后续原值校验拿一个库里不存在的值去比，永远 0 行命中。
  const txEpoch = useTxEpoch(connId, slot);
  const seenTxEpoch = useRef(txEpoch.seq);
  useEffect(() => {
    if (txEpoch.seq === seenTxEpoch.current) return;
    seenTxEpoch.current = txEpoch.seq;
    if (txEpoch.action === "rollback") setApplied(new Map());
  }, [txEpoch.seq, txEpoch.action]);
  const [saving, setSaving] = useState(false);
  const drafts = useRowDrafts(rows, columns.length);
  // `reset` 是稳定引用（useCallback），可以直接进依赖；`drafts` 对象本身每次渲染新建，不行。
  const resetDrafts = drafts.reset;

  // 「加载更多」是纯追加：旧行下标不变，上一批改动与草稿仍然对应原来的行。
  // 只有换了一条 SQL / 重新执行 / 换了结果集（前缀不一致）才清空。
  // 这里不能只看 `rows` 引用：续取成功后 store 总会生成新数组。
  const previous = useRef<{ sql: string; rows: Cell[][] } | null>(null);
  useEffect(() => {
    const prev = previous.current;
    previous.current = { sql, rows };
    const appended = !!prev && prev.sql === sql && rows.length >= prev.rows.length
      && prev.rows.every((row, i) => rows[i] === row);
    if (appended) return;
    setChanged(new Map());
    setApplied(new Map());
    resetDrafts();
  }, [sql, rows, resetDrafts]);

  /**
   * 写回成功后的「数据库当前值」：初始快照 + 已落库的新值。
   *
   * 后续写回的原值守卫、以及「改回原值就不算改动」的判定都必须以它为准。
   * 直接拿初始快照算的话，同一格改第二次时守卫会拿第一次之前的旧值去比，
   * 0 行命中，用户只看到「原值已被别人改过」。
   */
  const baseline = useMemo(() => {
    if (!applied.size) return rows;
    return rows.map((r, i) => r.map((cell, c) => (applied.has(`${i}:${c}`) ? applied.get(`${i}:${c}`)! : cell)));
  }, [rows, applied]);
  /** 显示行 = 上面那份 + 新增草稿行。 */
  const displayRows = useMemo(() => rowsWithDrafts(baseline, drafts.drafts, columns.length), [baseline, drafts.drafts, columns.length]);

  const edit = useMemo<GridEdit | undefined>(() => {
    if (!usable) return undefined;
    const update = (fn: (next: Map<string, Cell>) => void) =>
      setChanged(current => { const next = new Map(current); fn(next); return next; });
    const keyCols = keyInfo.keyCols;
    // 定位列在结果里可能出现多次（`select t.id, t.*`）：既然值相同，几格都锁住，
    // 否则改掉其中一格会让 WHERE 定位到「改之前」的那一行。
    const locked = new Set(keyInfo.lockedCols ?? keyCols);
    const base = baseline.length;
    /**
     * 同一个表列在结果里出现多次时，几格必须一起改：写回只改一个表列，
     * 不给另一格同步，同一次修改里就会一格新、一格旧。
     */
    const writeCell = (next: Map<string, Cell>, row: number, col: number, value: Cell) => {
      for (const c of [col, ...twinsOf(col)]) {
        if (sameCell(value, baseline[row]?.[c] ?? null)) next.delete(`${row}:${c}`);
        else next.set(`${row}:${c}`, value);
      }
    };
    return {
      canEdit: (col, row) => {
        const column = columns[col];
        if (!column || !editableCellType(column.type) || !sourceName(col)) return false;
        // 新增草稿行要允许填主键列（新行的定位靠它）；已有行的定位列不能改。
        if (row !== undefined && row >= base) return true;
        // 大文本预览只是前 8K + 一段说明，改它既写不回原值也会把说明当成数据。
        if (row !== undefined && isLobPreview(baseline[row]?.[col] ?? null)) return false;
        return !locked.has(col);
      },
      /** 可编辑结果里也有锁住的列：双击要说出这一格自己的原因，不能静默。 */
      blockedReason: (col, row) => {
        const column = columns[col];
        if (!column) return "这一列不在结果里";
        if (col === rowidCol) return "ROWID 是行标识列，不能当数据改";
        if (!editableCellType(column.type)) return `「${column.name}」是 ${column.type} 类型，网格里不能直接改；请用 SQL 更新`;
        if (!sourceName(col)) return `「${column.name}」是计算结果或对不上表列，改它没有对应的表列`;
        if (row !== undefined && row >= base) return "";
        if (row !== undefined && isLobPreview(baseline[row]?.[col] ?? null)) {
          return "这一格是大文本预览（只显示前 8K），不能在这里改；按 F4 查看完整值";
        }
        if (locked.has(col)) return `「${column.name}」是定位列，改了会定位不到原行`;
        return "";
      },
      changed,
      onEdit: (row, col, value) => {
        // 虚拟行号：填的是草稿，不进 `changed`（写回时按 INSERT 生成）。
        if (row >= base) {
          for (const c of [col, ...twinsOf(col)]) drafts.setCell(row, c, value);
          return;
        }
        update(next => writeCell(next, row, col, value));
      },
      onResetCell: (row, col) => {
        if (row >= base) {
          for (const c of [col, ...twinsOf(col)]) drafts.setCell(row, c, null);
          return;
        }
        update(next => { for (const c of [col, ...twinsOf(col)]) next.delete(`${row}:${c}`); });
      },
      onEditMany: (cells) => {
        for (const { row, col, value } of cells) {
          if (row >= base) {
            for (const c of [col, ...twinsOf(col)]) drafts.setCell(row, c, value);
            continue;
          }
          update(next => writeCell(next, row, col, value));
        }
      },
      // 复制这一行（新增）：主键列留空——同一主键插不进去，
      // 用户要的就是「照着抄一行再改」。
      onCloneRow: (row) => {
        const values = new Map<number, Cell>();
        const skipped: string[] = [];
        const locator = new Set([...locked, ...(rowidCol >= 0 ? [rowidCol] : [])]);
        baseline[row]?.forEach((cell, c) => {
          if (cell === null || locator.has(c)) return;
          if (isLobPreview(cell)) { skipped.push(columns[c]?.name ?? String(c + 1)); return; }
          values.set(c, cell);
        });
        if (skipped.length) toast(`复制行时跳过了大文本列 ${skipped.join("、")}：网格里只有前 8K，请重新填写或改用 SQL`, "warning");
        drafts.add(values);
      },
      rowState: (row) => drafts.status(row),
      isDraftRow: (row) => row >= base,
      onDeleteRow: (row) => drafts.removeRow(row),
      onRestoreRow: (row) => drafts.restoreRow(row),
    };
  }, [usable, columns, baseline, keyInfo.keyCols, keyInfo.lockedCols, rowidCol, sourceName, twinsOf, changed, drafts]);

  // 计划在 render 期算，但异常不会穿到 React：出错时保留原因交给工具条显示，
  // 别像以前那样静默变成「0 条」把按钮藏掉。
  const planned = useResultSetPlan({
    tableRef, columns, baseline, keyCols: keyInfo.keyCols, rowidCol, sourceName, changed,
    deleted: drafts.deleted, rows, drafts: drafts.drafts,
  });
  const changes = planned.changes;

  const plan = useCallback((): RowChange[] | null => {
    if (planned.error) { toast(planned.error, "error"); return null; }
    return changes.length ? changes : null;
  }, [planned.error, changes]);

  const count = changes.length;
  const planError = planned.error;
  /** 有任何未写回改动（含还没填值的新增草稿行）：换页 / 关标签前要问一句。 */
  const dirty = changed.size > 0 || drafts.pending > 0;

  const save = useCallback(() => {
    if (!connId || !usable) return;
    const changes = plan();
    if (!changes?.length) return;
    void (async () => {
      if (!(await confirmProdWrite(tabId, connId, changes.map(c => c.sql).join(";\n")))) return;
      setSaving(true);
      // 新的写入让上一条「提交失败 / 结果待核对」的横幅过时：状态条重新从这次事实说起。
      setTxNotice(connId, slot ?? null, tabId, undefined);
      let done = 0;
      let auto = false;
      const writeProgress = () => done === 0 ? "" : auto
        ? ` 前 ${done} 行已自动提交。`
        : ` 前 ${done} 行已写入当前会话，请核对事务状态。`;
      try {
        for (const change of changes) {
          const r = await dbApi.execBound(connId, change.sql, change.params, 1, 60, slot ?? null);
          // 写回同样要记事务计数：不记的话库里已经有未提交的 DML，界面却还说「没有未提交事务」，
          // 提交按钮是灰的，用户只能靠再执行一条语句把它「撞」出来（表页 useTableSave 一直这么做）。
          if (r.tx) {
            auto = r.tx.autoCommit;
            if (slot) patchTab<SqlTab>(tabId, { tx: r.tx });
            else setTx(connId, r.tx);
          }
          if (r.kind !== "update" || r.updateCount !== 1) {
            // 三种没命中要说不同的话：INSERT 失败多半是必填列没填 / 唯一键冲突，
            // DELETE 没命中是「别人先删了」，UPDATE 没命中是原值被改过。
            const reason = change.kind === "insert"
              ? "新增行写回失败：可能必填列没填或唯一键冲突，已停止写回。"
              : change.kind === "delete"
                ? `第 ${change.row + 1} 行在写回前已被其他人删除，删除没有命中，已停止写回。`
                : `第 ${done + 1} 条没命中记录：原值已被别人改过或记录已删除。已停止写回。`;
            toast(reason + writeProgress(), "error");
            break;
          }
          done += 1;
          if (change.kind === "update") {
            setApplied(current => {
              const next = new Map(current);
              for (const x of change.cells) next.set(`${change.row}:${x.column}`, x.after);
              return next;
            });
            setChanged(current => {
              const next = new Map(current);
              change.cells.forEach(x => next.delete(`${change.row}:${x.column}`));
              return next;
            });
          } else {
            // 新增 / 删除成功后撤掉标记。新增是倒序执行的，撤草稿不会影响还没写回的那几行。
            drafts.restoreRow(change.row);
          }
        }
        if (done === changes.length) {
          toast(auto ? `已提交 ${done} 行（自动提交）` : `已写入 ${done} 行 · 待提交。可提交或回滚当前会话。`, auto ? "success" : "info");
        }
      } catch (e) {
        toast(friendlyDbError(e) + writeProgress(), "error");
      } finally {
        setSaving(false);
      }
    })();
  }, [connId, usable, plan, tabId, slot, drafts]);

  return {
    edit,
    blocked,
    /** 双击不可编辑时的一次性提示：原因 + 下一步 + 查询摘要。 */
    blockedHint: blocked ? `${blocked}。${model.diagnostics.next}（查询：${model.diagnostics.sql}）` : "",
    /** 诊断面板要的全部信息（基表、定位方式、缺的主键列、不可编辑列）。 */
    diagnostics: model.diagnostics,
    /** 手动指定基表 / 定位列（没有主键或 SQL 结构判不出来时的出口）。 */
    applyTarget: model.applyTarget,
    clearTarget: model.clearTarget,
    forced: model.forced,
    count,
    /** 计划生成失败 / 有大文本预览被改：工具条显示原因，不要静默归零。 */
    planError,
    dirty,
    saving,
    binarySqlForRow: (row: number, column: number) => {
      const field = sourceName(column);
      if (!field || !tableRef || model.forced || model.meta?.table !== tableRef) return null;
      const name = model.meta.all.find(name => name.toUpperCase() === field.toUpperCase());
      return name ? binaryRowSql(tableRef, columns.map((col, index) => ({ ...col, name: sourceName(index) ?? "" })), rows[row], model.meta.pk, name) : null;
    },
    save,
    reset: () => { setChanged(new Map()); drafts.reset(); },
    /** 显示行（含写回覆盖与新增草稿行）：调用方直接拿它喂网格。 */
    rows: displayRows,
  };
}
