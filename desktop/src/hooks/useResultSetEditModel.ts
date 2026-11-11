import { useCallback, useEffect, useMemo, useState } from "react";
import { qualifyTable } from "../lib/db";
import type { ColumnMeta } from "../lib/dbApi";
import { useDbReadOnly } from "../lib/dbReadOnly";
import { buildEditDiagnostics } from "../lib/editDiagnostics";
import { columnsOf } from "../lib/dbStore";
import { editableCellType, editableCustomKeys, editableIdentity, type EditKeyInfo } from "../lib/sqlEditable";
import { analyzeSql, type QuerySource } from "../lib/sqlSource";

/** 用户手动指定的编辑目标（DataGrip 的「指定基表」+ DBeaver 的 virtual key）。 */
export interface EditTarget {
  /** 绑定到这条 SQL：换一条查询就失效，不能把上一张表的定位方式带过去。 */
  sql: string;
  /** 带 schema 的表名。 */
  table: string;
  /** 定位列（结果列名，大写）；空 = 让逻辑再按主键找。 */
  keys: string[];
}

interface TableMeta {
  table: string;
  pk: string[];
  all: string[];
  found: boolean;
}

const loadingKeys: EditKeyInfo = { keys: [], keyCols: [], kind: null, reason: "正在读取表结构…", missing: [] };

/**
 * 结果页编辑判定的「纯模型」：SQL 解析、基表、表结构、定位列、列映射、诊断。
 *
 * 从 `useResultSetEdit` 抽出来是为了守住组件体量门禁，也让判定可以单独测试；
 * 这里不碰 changed/drafts/保存，只有「能不能改、按什么定位、为什么不能改」。
 */
export function useResultSetEditModel({ connId, sql, schema, columns }: {
  connId: string | null;
  sql: string;
  schema?: string;
  columns: ColumnMeta[];
}) {
  const analyzed = useMemo(() => analyzeSql(sql), [sql]);
  const [target, setTarget] = useState<EditTarget | null>(null);
  useEffect(() => { setTarget(null); }, [sql]);
  const forced = target && target.sql === sql ? target : null;

  const source = useMemo<QuerySource>(() => (forced ? {
    table: forced.table, alias: null, star: true, mapping: new Map(), rowid: false,
    reason: "", code: "ok", detail: `手动指定基表 ${forced.table}`,
  } : analyzed), [forced, analyzed]);
  const tableRef = useMemo(() => (source.table ? qualifyTable(schema, source.table) : null), [source.table, schema]);

  const [meta, setMeta] = useState<TableMeta | null>(null);
  useEffect(() => {
    if (!connId || !tableRef) { setMeta(null); return; }
    const table = tableRef;
    let alive = true;
    setMeta(null);
    // 走 `columnsOf` 的 promise 缓存：同一个连接 + 表在多个结果页间切换不重复查字典。
    // 表名带上执行时的 schema，旧结果不会因为后来切 schema 而读到同名表的列。
    void columnsOf(connId, table).then(
      // 后端给空 / 给意外结构都当「读不到」处理：这里抛异常只会变成未处理的 rejection，
      // 界面上什么都不会发生——比只读更糟，用户完全无从判断。
      r => {
        if (!alive) return;
        const cols = Array.isArray(r) ? r : [];
        setMeta({
          table,
          pk: cols.filter(c => c.pk).map(c => c.name),
          all: cols.map(c => c.name),
          found: cols.length > 0,
        });
      },
      () => { if (alive) setMeta({ table, pk: [], all: [], found: false }); },
    );
    return () => { alive = false; };
  }, [connId, tableRef]);

  const readonly = useDbReadOnly(connId);
  /**
   * ROWID 伪列：优先按类型认（驱动能给出 ROWID 类型），其次按「SQL 里显式选了 rowid」
   * + 结果列名认。真实表列不会叫 ROWID（Oracle 保留字），误判风险很低。
   */
  const rowidCol = useMemo(() => {
    // 手动指定基表时不认结果里的 ROWID：关联结果里的 rowid 属于哪张表就说不准了。
    const byType = forced ? -1 : columns.findIndex(c => /^ROWID$/i.test(c.type));
    if (byType >= 0) return byType;
    if (forced || !source.rowid) return -1;
    return columns.findIndex(c => c.name.toUpperCase() === "ROWID");
  }, [columns, source.rowid, forced]);

  /**
   * 结果列 → 表列。
   *
   * 同一个表列在结果里出现多次时（`select t.code, t.*`）**不**返回 null：几格取的是
   * 同一个值，改哪一格写回的都该是 `CODE`。同步与写回去重交给 `twinsOf` /
   * `dbOptimisticEdit`，别用「不给改」来处理重复列——那会让 `t.x, t.*` 这种最顺手的
   * 写法整列变只读，用户还以为是软件不支持改数据。
   */
  const sourceName = useCallback((col: number): string | null => {
    const c = columns[col];
    if (!c || col === rowidCol) return null;
    const upper = c.name.toUpperCase();
    const name = forced ? c.name
      : source.mapping.has(upper) ? (source.mapping.get(upper) ?? null)
        : source.star ? c.name : null;
    if (!name) return null;
    // 显式列和 `*` 都可能带出表里不存在的名字（`sysdate as now`），按真实列名校验；
    // 表结构还没读到时不拦，`usable` 本身要等 keyInfo 就绪。
    if (!meta || meta.table !== tableRef || !meta.found) return name;
    return meta.all.some(n => n.toUpperCase() === name.toUpperCase()) ? name : null;
  }, [columns, rowidCol, forced, source, meta, tableRef]);

  const colsBySource = useMemo(() => {
    const map = new Map<string, number[]>();
    for (let i = 0; i < columns.length; i += 1) {
      const name = sourceName(i)?.toUpperCase();
      if (name) map.set(name, [...(map.get(name) ?? []), i]);
    }
    return map;
  }, [columns, sourceName]);

  /**
   * 与这一格对应同一个表列的其它结果列。
   *
   * 写回只改一个表列，这些格子必须跟着变，否则同一次修改里一格新、一格旧。
   */
  const twinsOf = useCallback((col: number): number[] => {
    const name = sourceName(col)?.toUpperCase();
    return name ? (colsBySource.get(name) ?? []).filter(i => i !== col) : [];
  }, [colsBySource, sourceName]);

  const keyInfo = useMemo<EditKeyInfo>(() => {
    if (!source.table) return { keys: [], keyCols: [], kind: null, reason: source.reason, missing: [] };
    if (!meta || meta.table !== tableRef) return loadingKeys;
    if (forced) {
      if (!meta.found) return { keys: [], keyCols: [], kind: null, missing: [], reason: `读不到表 ${tableRef} 的列信息，可能不在该 schema 或没有权限` };
      if (forced.keys.length) return editableCustomKeys(columns, forced.keys, sourceName);
    }
    if (rowidCol >= 0) return { keys: ["ROWID"], keyCols: [], kind: "rowid", reason: "", missing: [] };
    if (!meta.found && !forced) {
      return { keys: [], keyCols: [], kind: null, missing: [], reason: `读不到表 ${tableRef} 的列信息，可能不在该 schema 或没有权限` };
    }
    return editableIdentity(columns, meta.pk, sourceName, rowidCol);
  }, [source, meta, tableRef, forced, rowidCol, columns, sourceName]);

  const readonlyColumns = useMemo(() => columns.flatMap((c, i) => {
    if (i === rowidCol) return [{ name: c.name, why: "行标识列，不能当数据改" }];
    if (!sourceName(i)) {
      const mapped = source.mapping.get(c.name.toUpperCase());
      return [{ name: c.name, why: mapped === null ? "计算结果 / 表达式列" : "对不上表列（列名被重命名或不在表里）" }];
    }
    return editableCellType(c.type) ? [] : [{ name: c.name, why: `类型 ${c.type} 不支持直接写回` }];
  }), [columns, rowidCol, sourceName, source.mapping]);

  // 只读状态没读到（null）时也不放行：宁可先只读，也不要猜。
  const usable = !!connId && readonly === false && keyInfo.reason === "";
  /**
   * 顺序很关键：**能确定的先说**——SQL 结构不支持、连接只读，这些是根因；
   * 「正在读取」只是加载态，不能盖掉根因，否则读表结构的请求失败时会永远停在
   * 「正在读取」，用户永远等不到答案。
   */
  const blocked = usable ? "" : (
    !source.table ? source.reason
      : readonly === true ? "当前连接是只读模式"
        : readonly === null ? "只读状态尚未确认，请在上方连接条重试探测"
          : keyInfo.reason.startsWith("正在") ? "正在确认连接状态和表结构…"
            : keyInfo.reason
  );

  const diagnostics = useMemo(() => buildEditDiagnostics({
    sql, source, keyInfo, readonly, readonlyColumns, forced: !!forced, usable, blocked,
    risky: analyzed.code !== "ok",
  }), [sql, source, keyInfo, readonly, readonlyColumns, forced, usable, blocked, analyzed.code]);

  const applyTarget = useCallback((table: string, keys: string[]) => setTarget({ sql, table, keys }), [sql]);
  const clearTarget = useCallback(() => setTarget(null), []);

  return {
    source,
    analyzed,
    tableRef,
    meta,
    readonly,
    rowidCol,
    sourceName,
    twinsOf,
    keyInfo,
    readonlyColumns,
    usable,
    blocked,
    diagnostics,
    forced: !!forced,
    applyTarget,
    clearTarget,
  };
}
