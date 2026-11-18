import { useEffect, useState } from "react";
import { toast } from "../components/ui/toast";
import { canDeepDive, planDeepDive, relationHintOf, warmResultRelations } from "../lib/resultRelationHint";

export interface ResultDeepDive {
  /** 有已读到的关系才非 null：入口出不出现全看它（与编辑器表名 chip 同一条规矩）。 */
  hint: { table: string; count: number } | null;
  /** 正在读列生成 SQL：按钮置忙，别让人连点。 */
  busy: boolean;
  /** 点入口：能生成就把联查 SQL 交出去填编辑器，生成不了就退回定位。 */
  run: () => void;
}

/**
 * 结果页「带出子表明细」（查完主表顺手看子表明细）。
 *
 * 编辑器侧的表名 chip 覆盖的是「写 SQL 时」，这里补的是「查完之后」这个时机。
 * 两个时机差在这里：查完 SQL 时光标未必在表名上停够 400ms，业务关系快照里常常
 * 还没有这张表，所以挂载时先按 `sqlAssistGhost` 那套口径预热一次，读到了才显示入口。
 *
 * 不自动执行：SQL 交给调用方填进编辑器，执不执行由用户定——带出来的联查只是起点，
 * 单号、条件都还得用户自己填。
 */
export function useResultDeepDive(input: {
  connId: string | null | undefined;
  /** 主表名（`guessTable(entry.sql)` 的结果）；空 = 没什么可深挖的。 */
  table: string;
  /** 结果对应语句在编辑器里的行号，退回定位时用。 */
  line: number;
  /** 有地方填 SQL 才挂入口（只有 SQL 控制台传）；不传 = 整个不显示。 */
  onFillSql?: (sql: string) => void;
  onLocate?: (line: number) => void;
}): ResultDeepDive {
  const { connId, table, line, onFillSql, onLocate } = input;
  const [busy, setBusy] = useState(false);
  // 预热读到了 bump 一次重画：下面 `hint` 不走 useMemo，重画即重算。
  const [, setWarmed] = useState(0);
  useEffect(() => {
    if (!onFillSql || !connId || !table) return;
    let alive = true;
    void warmResultRelations(connId, table).then(() => { if (alive) setWarmed(n => n + 1); });
    return () => { alive = false; };
  }, [connId, table, onFillSql]);
  const hint = onFillSql && canDeepDive(connId) ? relationHintOf(connId, table) : null;
  return {
    hint, busy,
    run: () => {
      if (!connId || !table) return;
      setBusy(true);
      void planDeepDive({ connId, table, line }).then((plan) => {
        if (plan.kind === "sql") onFillSql?.(plan.sql);
        // 生成不了（列读不到 / 模板不成立）就退回定位：chip 在编辑器里等着，那条路永远走得通。
        else if (onLocate) onLocate(plan.line);
        else toast("暂时没能生成联查 SQL，可在编辑器里点表名旁的「主子表联查」", "info");
      }).finally(() => setBusy(false));
    },
  };
}
