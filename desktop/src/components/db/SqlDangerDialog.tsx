import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { thousands } from "../../lib/db";
import { dbApi, type Cell } from "../../lib/dbApi";
import { friendlyDbError } from "../../lib/db";
import { ensureConnected } from "../../lib/dbConfirm";
import type { DangerFinding } from "../../lib/sqlDanger";

export interface DangerItem { index: number; sql: string; finding: DangerFinding }

/** `bd_material m` → `bd_material`：全表行数要查不带别名的那张表。 */
function baseTable(ref: string): string {
  return /^[\w$#"]+(?:\.[\w$#"]+)?/.exec(ref.trim())?.[0] ?? ref.trim();
}

/**
 * 危险语句确认：没有 WHERE 的 UPDATE / DELETE 执行前拦一次。
 *
 * 「预估影响行数」是**手动**触发的：自动跑等于给每次执行都加一次全表 COUNT，
 * 在 NC 账套的大表上（几百万行）会直接把一次手滑变成几十秒等待。
 */
export function SqlDangerDialog({ items, total, connId, slot, onCancel, onConfirm }: {
  items: DangerItem[];
  /** 本次执行范围里的语句总数；比 `items.length` 大时说明还有别的语句会一起跑。 */
  total?: number;
  connId: string;
  slot: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  /** 每条的预估结果：数字 = 命中行数，字符串 = 失败原因。 */
  const [counts, setCounts] = useState<Record<number, { hit: number; total?: number } | string>>({});

  const estimate = async (at: number) => {
    const f = items[at].finding;
    if (!f.countSql || busy !== null) return;
    setBusy(at);
    try {
      // 直接 return 会让按钮回到「预估影响行数」却什么都不说，用户只会反复点；
      // 抛出来走 catch，把原因显示在这一条下面。
      if (!(await ensureConnected(connId))) throw new Error("连接已断开，先重连再预估");
      const hit = await countOf(connId, slot, f.countSql);
      // 无 WHERE 时这条 COUNT 就是全表，别再白跑第二遍（大表上是双倍等待）
      const base = `select count(*) from ${baseTable(f.table)}`;
      const wholeTable = f.countSql.trim().toLowerCase() === base.toLowerCase();
      const total = wholeTable ? hit : f.table ? await countOf(connId, slot, base).catch(() => undefined) : undefined;
      setCounts(c => ({ ...c, [at]: total === undefined ? { hit } : { hit, total } }));
    } catch (e) {
      setCounts(c => ({ ...c, [at]: friendlyDbError(e) }));
    } finally {
      setBusy(null);
    }
  };

  const blocked = items.filter(i => !i.finding.advisory);
  return (
    <Modal open onClose={onCancel} ariaLabel="危险语句确认" className="modal-surface">
      <h2 style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Icon name="alert" size={15} />
        这条语句会改动整张表
      </h2>
      <p className="dbx-muted">
        没有 WHERE 条件（或只有 <code>WHERE 1=1</code>），执行会作用到目标表的<strong>全部行</strong>。
        数据库没有「撤销」，只能靠回滚或备份。
      </p>
      {/* 「仍要执行」跑的是整个执行范围，不只是框里列出的这几条：不说明白会误伤 */}
      {typeof total === "number" && total > items.length && (
        <p className="dbx-muted">本次共 {total} 条语句会一起执行，下面只列出需要确认的 {items.length} 条。</p>
      )}
      {blocked.map(item => {
        const at = items.indexOf(item);
        const result = counts[at];
        return (
          <div key={`${item.index}:${item.sql.slice(0, 24)}`} className="dbx-err" style={{ marginTop: 8 }}>
            <div className="dbx-feedback-heading">
              <Icon name="alert" size={13} />
              第 {item.index + 1} 条 · {item.finding.verb === "DELETE" ? "删除" : "更新"} <code>{item.finding.table}</code>
            </div>
            <pre className="dbx-mono" style={{ whiteSpace: "pre-wrap", margin: "4px 0", maxHeight: 96, overflow: "auto" }}>{item.sql}</pre>
            {result !== undefined && (typeof result === "string"
              ? <span className="dbx-muted">预估失败：{result}</span>
              : <span>
                  会影响 <b>{thousands(result.hit)}</b> 行
                  {result.total ? <> · 全表 {thousands(result.total)} 行（约 {Math.round((result.hit / result.total) * 100)}%）</> : null}
                </span>)}
            {/* 失败后仍留一个「重试」：重连之后不该逼用户关掉弹框重开 */}
            {item.finding.countSql && (result === undefined || typeof result === "string") && (
              <button type="button" className="dbx-btn" disabled={busy !== null} onClick={() => void estimate(at)}>
                {busy === at ? "正在数…" : result === undefined ? "预估影响行数" : "重试"}
              </button>
            )}
          </div>
        );
      })}
      <div className="dbx-filter-actions" style={{ marginTop: 12 }}>
        <button type="button" className="dbx-btn" onClick={onCancel}>取消，不执行</button>
        <button type="button" className="dbx-btn pri" onClick={onConfirm}>仍要执行</button>
      </div>
    </Modal>
  );
}

/** 跑一条 COUNT，用完立刻释放游标（它不该出现在结果标签里）。 */
async function countOf(connId: string, slot: string | null, sql: string): Promise<number> {
  const id = `danger-count-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  try {
    const r = await dbApi.execResult(connId, sql, 1, 30, slot, false, id);
    if (r.kind !== "rows") return 0;
    const cell: Cell | undefined = r.rows[0]?.[0];
    const n = Number(cell);
    return Number.isFinite(n) ? n : 0;
  } finally {
    await dbApi.closeResult(connId, slot, id).catch(() => { /* 会话已回收 */ });
  }
}
