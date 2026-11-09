import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "../components/ui/toast";
import { friendlyDbError, sameCell } from "../lib/db";
import { dbApi, type Cell, type ColumnMeta } from "../lib/dbApi";
import { confirmProdWrite } from "../lib/dbConfirm";
import { useDbReadOnly } from "../lib/dbReadOnly";
import { deleteChange, insertChange, optimisticChanges, planWriteBack, type RowChange } from "../lib/dbOptimisticEdit";
import { editableCellType, editableKeys, editableSource } from "../lib/sqlEditable";
import { rowsWithDrafts } from "../lib/tableRows";
import { useRowDrafts } from "./useRowDrafts";
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
export function useResultSetEdit({ tabId, connId, slot, sql, columns, rows }: {
  tabId: string;
  connId: string | null;
  slot?: string | null;
  sql: string;
  columns: ColumnMeta[];
  rows: Cell[][];
}) {
  const source = useMemo(() => editableSource(sql), [sql]);
  /**
   * 表结构读取结果。`found` 用来区分「表读不到」与「表读到了但没有主键」——
   * 两种都不可编辑，但对用户要说不同的话，否则他只会看到「只读」两个字，
   * 也分不清是自己 SQL 写错了还是这张表本来就不能改。
   */
  const [meta, setMeta] = useState<{ table: string; names: string[]; found: boolean } | null>(null);
  const readonly = useDbReadOnly(connId);
  const [changed, setChanged] = useState<Map<string, Cell>>(new Map());
  /** 写回成功后更新的值：`行:列` → 新值。基准是数据库快照，不是屏幕上被草稿行改过的行。 */
  const [applied, setApplied] = useState<Map<string, Cell>>(new Map());
  const [saving, setSaving] = useState(false);
  const drafts = useRowDrafts(rows, columns.length);
  // `reset` 是稳定引用（useCallback），可以直接进依赖；`drafts` 对象本身每次渲染新建，不行。
  const resetDrafts = drafts.reset;

  // 换了一条 SQL 或一批新行（含「加载更多」后续取），上一批改动与草稿都不再对应任何东西。
  useEffect(() => {
    setChanged(new Map());
    setApplied(new Map());
    resetDrafts();
  }, [sql, rows, resetDrafts]);

  useEffect(() => {
    if (!connId || !source.table) { setMeta(null); return; }
    const table = source.table;
    let alive = true;
    setMeta(null);
    void dbApi.columns(connId, table).then(
      // 后端给空 / 给意外结构都当「读不到」处理：这里抛异常只会变成未处理的 rejection，
      // 界面上什么都不会发生——比只读更糟，用户完全无从判断。
      r => {
        if (!alive) return;
        const cols = Array.isArray(r?.columns) ? r.columns : [];
        setMeta({ table, names: cols.filter(c => c.pk).map(c => c.name), found: cols.length > 0 });
      },
      () => { if (alive) setMeta({ table, names: [], found: false }); },
    );
    return () => { alive = false; };
  }, [connId, source.table]);

  const keyInfo = useMemo(() => {
    if (!source.table) return { keys: [] as string[], reason: source.reason };
    if (!meta || meta.table !== source.table) return { keys: [] as string[], reason: "正在读取表结构…" };
    if (!meta.found) {
      return { keys: [] as string[], reason: `读不到表 ${source.table} 的列信息，可能不在当前 schema 或没有权限` };
    }
    return editableKeys(columns, meta.names);
  }, [source, meta, columns]);

  // 只读状态没读到（null）时也不放行：宁可先只读，也不要猜。
  const usable = !!connId && readonly === false && keyInfo.reason === "";

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
    const keys = keyInfo.keys;
    const base = rows.length;
    return {
      canEdit: (col, row) => {
        const meta = columns[col];
        if (!meta || !editableCellType(meta.type)) return false;
        // 新增草稿行要允许填主键列（新行的定位靠它）；已有行的主键列不能改。
        if (row !== undefined && row >= base) return true;
        return row === undefined || !keys.includes(meta.name.toUpperCase());
      },
      changed,
      onEdit: (row, col, value) => {
        // 虚拟行号：填的是草稿，不进 `changed`（写回时按 INSERT 生成）。
        if (row >= base) { drafts.setCell(row, col, value); return; }
        update(next => {
          if (sameCell(value, baseline[row]?.[col] ?? null)) next.delete(`${row}:${col}`);
          else next.set(`${row}:${col}`, value);
        });
      },
      onResetCell: (row, col) => {
        if (row >= base) { drafts.setCell(row, col, null); return; }
        update(next => { next.delete(`${row}:${col}`); });
      },
      onEditMany: (cells) => {
        for (const { row, col, value } of cells) {
          if (row >= base) { drafts.setCell(row, col, value); continue; }
          update(next => {
            if (sameCell(value, baseline[row]?.[col] ?? null)) next.delete(`${row}:${col}`);
            else next.set(`${row}:${col}`, value);
          });
        }
      },
      // 复制这一行（新增）：主键列留空——同一主键插不进去，
      // 用户要的就是「照着抄一行再改」。
      onCloneRow: (row) => {
        const values = new Map<number, Cell>();
        rows[row]?.forEach((cell, c) => {
          if (cell === null || keys.includes(columns[c]?.name.toUpperCase() ?? "")) return;
          values.set(c, cell);
        });
        drafts.add(values);
      },
      rowState: (row) => drafts.status(row),
      isDraftRow: (row) => row >= base,
      onDeleteRow: (row) => drafts.removeRow(row),
      onRestoreRow: (row) => drafts.restoreRow(row),
    };
  }, [usable, columns, baseline, keyInfo.keys, changed, drafts]);

  /** 待写回的删除：只按主键定位，主键取 `rows` 原值里的（屏幕上的改动不影响删哪一行）。 */
  const deleteChanges = useCallback((): RowChange[] => {
    if (!source.table) return [];
    return drafts.deleted.map(r => {
      const row = rows[r];
      if (!row) throw new Error(`第 ${r + 1} 行已不在结果里，不能删除`);
      return deleteChange(source.table!, columns, row, keyInfo.keys, r);
    });
  }, [source.table, drafts.deleted, rows, columns, keyInfo.keys]);

  /** 待写回的新增：没填任何值的草稿行跳过——空 INSERT 没有意义，留给数据库默认值。 */
  const insertChanges = useCallback((): RowChange[] => {
    if (!source.table) return [];
    const out: RowChange[] = [];
    drafts.drafts.forEach((d, i) => {
      if (!d.values.size) return;
      out.push(insertChange(source.table!, columns, d.values, rows.length + i));
    });
    return out;
  }, [source.table, drafts.drafts, columns, rows.length]);

  const plan = useCallback((): RowChange[] | null => {
    if (!source.table) return null;
    try {
      // 先删、再改、后插的排序由 `planWriteBack` 统一做，三类变更一起排。
      return planWriteBack([
        ...optimisticChanges(source.table, columns, baseline, keyInfo.keys, changed),
        ...deleteChanges(),
        ...insertChanges(),
      ]);
    } catch (e) {
      toast(friendlyDbError(e), "error");
      return null;
    }
  }, [source.table, columns, baseline, keyInfo.keys, changed, deleteChanges, insertChanges]);

  const count = useMemo(() => {
    try {
      const updates = source.table ? optimisticChanges(source.table, columns, baseline, keyInfo.keys, changed).length : 0;
      return updates + drafts.deleted.length + insertChanges().length;
    } catch { return 0; }
  }, [source.table, columns, baseline, keyInfo.keys, changed, drafts.deleted, insertChanges]);

  const save = useCallback(() => {
    if (!connId || !usable) return;
    const changes = plan();
    if (!changes?.length) return;
    void (async () => {
      if (!(await confirmProdWrite(tabId, connId, changes.map(c => c.sql).join(";\n")))) return;
      setSaving(true);
      let done = 0;
      try {
        for (const change of changes) {
          const r = await dbApi.execBound(connId, change.sql, change.params, 1, 60, slot ?? null);
          if (r.kind !== "update" || r.updateCount !== 1) {
            // 三种没命中要说不同的话：INSERT 失败多半是必填列没填 / 唯一键冲突，
            // DELETE 没命中是「别人先删了」，UPDATE 没命中是原值被改过。
            toast(change.kind === "insert"
              ? "新增行写回失败：可能必填列没填或唯一键冲突，已停止写回。"
              : change.kind === "delete"
                ? `第 ${change.row + 1} 行在写回前已被其他人删除，删除没有命中，已停止写回。`
                : `第 ${done + 1} 条没命中记录：原值已被别人改过或记录已删除。已停止，此前 ${done} 条已生效。`, "error");
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
        if (done === changes.length) toast(`已写回 ${done} 条修改`, "success");
      } catch (e) {
        toast(friendlyDbError(e), "error");
      } finally {
        setSaving(false);
      }
    })();
  }, [connId, usable, plan, tabId, slot, drafts]);

  /**
   * 不可编辑的原因给用户看。顺序很关键：**能确定的先说**——SQL 结构不支持、
   * 连接只读，这些是根因；「正在读取」只是加载态，不能盖掉根因，
   * 否则读表结构的请求失败时会永远停在「正在读取」，用户永远等不到答案。
   */
  const blocked = usable ? "" : (
    !source.table ? source.reason
      : readonly === true ? "当前连接是只读模式"
        : keyInfo.reason.startsWith("正在") ? "正在确认连接状态和表结构…"
          : keyInfo.reason
  );

  return {
    edit,
    blocked,
    count,
    saving,
    save,
    reset: () => { setChanged(new Map()); drafts.reset(); },
    /** 显示行（含写回覆盖与新增草稿行）：调用方直接拿它喂网格。 */
    rows: displayRows,
  };
}
