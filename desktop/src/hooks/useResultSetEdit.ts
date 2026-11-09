import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "../components/ui/toast";
import { friendlyDbError, sameCell } from "../lib/db";
import { dbApi, type Cell, type ColumnMeta } from "../lib/dbApi";
import { confirmProdWrite } from "../lib/dbConfirm";
import { useDbReadOnly } from "../lib/dbReadOnly";
import { optimisticChanges, planWriteBack, type RowChange } from "../lib/dbOptimisticEdit";
import { editableCellType, editableKeys, editableSource } from "../lib/sqlEditable";
import type { GridEdit } from "../components/db/gridEdit";

/**
 * SQL 控制台结果页的「直接改数据」。
 *
 * 与表页共用同一套写回口径（`optimisticChanges` + 原值守卫 + 生产库确认），
 * 差别只在定位方式：表页知道自己查的是哪张表，而这里要先从 SQL 判断。
 * 判断不成立时**照样把原因返回给界面**——用户需要知道为什么双击没反应。
 *
 * 写回结果通过 `onApplied` 交回调用方改本地行；这里不碰 store，
 * 因为结果集是执行时的一次快照，改了就与「再执行一次会看到什么」不一致。
 */
export function useResultSetEdit({ tabId, connId, slot, sql, columns, rows, onApplied }: {
  tabId: string;
  connId: string | null;
  slot?: string | null;
  sql: string;
  columns: ColumnMeta[];
  rows: Cell[][];
  onApplied: (updates: { row: number; col: number; value: Cell }[]) => void;
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
  const [saving, setSaving] = useState(false);

  // 换了一条 SQL 或一批新行，上一批改动不再对应任何东西。
  useEffect(() => { setChanged(new Map()); }, [sql, rows]);

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

  const edit = useMemo<GridEdit | undefined>(() => {
    if (!usable) return undefined;
    const update = (fn: (next: Map<string, Cell>) => void) =>
      setChanged(current => { const next = new Map(current); fn(next); return next; });
    const keys = keyInfo.keys;
    return {
      // 没有新增行：结果集里凭空插一行不知道该往哪张表插，这里只做改与撤回。
      canEdit: (col, row) => {
        const meta = columns[col];
        if (!meta || !editableCellType(meta.type)) return false;
        return row === undefined || !keys.includes(meta.name.toUpperCase());
      },
      changed,
      onEdit: (row, col, value) => update(next => {
        if (sameCell(value, rows[row]?.[col] ?? null)) next.delete(`${row}:${col}`);
        else next.set(`${row}:${col}`, value);
      }),
      onResetCell: (row, col) => update(next => { next.delete(`${row}:${col}`); }),
      onEditMany: (cells) => update(next => {
        for (const { row, col, value } of cells) {
          if (sameCell(value, rows[row]?.[col] ?? null)) next.delete(`${row}:${col}`);
          else next.set(`${row}:${col}`, value);
        }
      }),
    };
  }, [usable, columns, rows, keyInfo.keys, changed]);

  const plan = useCallback((): RowChange[] | null => {
    if (!source.table) return null;
    try {
      return planWriteBack(optimisticChanges(source.table, columns, rows, keyInfo.keys, changed));
    } catch (e) {
      toast(friendlyDbError(e), "error");
      return null;
    }
  }, [source.table, columns, rows, keyInfo.keys, changed]);

  const count = useMemo(() => {
    try { return source.table ? optimisticChanges(source.table, columns, rows, keyInfo.keys, changed).length : 0; }
    catch { return 0; }
  }, [source.table, columns, rows, keyInfo.keys, changed]);

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
            toast(`第 ${done + 1} 条没命中记录：原值已被别人改过或记录已删除。已停止，此前 ${done} 条已生效。`, "error");
            break;
          }
          done += 1;
        }
        if (done === changes.length) toast(`已写回 ${done} 条修改`, "success");
        onApplied(changes.slice(0, done).flatMap(c => c.cells.map(x => ({ row: c.row, col: x.column, value: x.after }))));
        setChanged(current => {
          const next = new Map(current);
          changes.slice(0, done).forEach(c => c.cells.forEach(x => next.delete(`${c.row}:${x.column}`)));
          return next;
        });
      } catch (e) {
        toast(friendlyDbError(e), "error");
      } finally {
        setSaving(false);
      }
    })();
  }, [connId, usable, plan, tabId, slot, onApplied]);

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
    reset: () => setChanged(new Map()),
  };
}
