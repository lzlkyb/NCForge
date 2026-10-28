import { useEffect } from "react";
import { dbCachedTables, dbColumns, type DbColumn } from "../lib/db";
import { agoText } from "../lib/tableHover";
import { setTableLookup } from "../lib/tableLookup";

/**
 * 把「编辑器里悬停表名」接到数据库上。
 *
 * 做法：进应用时拉一次**表名清单**（几千个字符串，一次 IPC），之后 Monaco 用一个
 * 纯字符串比较就能判断「光标下这个词是不是表名」，确认是了才来要字段。
 * 字段按表缓存，同一张表只问一次。
 *
 * 拉不到（没配 NC home、没拉过表结构）就静默什么都不做——悬停不生效而已，
 * 不该因为数据库没配好就在工作区页弹错误。
 *
 * 缓存在数据库页刷新后靠 `schemachange` 事件通知重拉。
 */
export function useTableLookup(): void {
  useEffect(() => {
    let alive = true;
    const tables = new Set<string>();
    const cols = new Map<string, DbColumn[]>();
    let age = "";

    const wire = () => {
      if (!alive) return;
      setTableLookup({
        has: (t) => tables.has(t.toLowerCase()),
        columns: async (t) => {
          const key = t.toLowerCase();
          const hit = cols.get(key);
          if (hit) return hit;
          try {
            const r = await dbColumns(key);
            cols.set(key, r.columns);
            return r.columns;
          } catch {
            // 单表查询失败（库断了/表不在）不该让悬停报错，返回 null 即可
            return null;
          }
        },
        cacheAge: () => age,
      });
    };

    const load = async () => {
      try {
        const r = await dbCachedTables();
        if (!alive) return;
        tables.clear();
        for (const t of r.tables) tables.add(t.toLowerCase());
        cols.clear();
        age = r.fetchedAt ? agoText(Math.floor(Date.now() / 1000) - r.fetchedAt) : "";
      } catch {
        // 没数据库就当没有这个能力
      }
      wire();
    };

    void load();
    window.addEventListener("schemachange", load);
    return () => {
      alive = false;
      window.removeEventListener("schemachange", load);
      setTableLookup(null);
    };
  }, []);
}
