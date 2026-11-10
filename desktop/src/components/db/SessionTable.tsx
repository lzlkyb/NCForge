import type { SessionRow } from "../../lib/dbApi";

/** 会话表：SID / 用户 / 状态 / 等待 / 锁 / SQL。点 SID 看选中那一刻的快照。 */
export function SessionTable({ rows, onSelect, onCopy }: {
  rows: SessionRow[];
  onSelect: (row: SessionRow) => void;
  onCopy: (text: string, what: string) => void;
}) {
  return (
    <table className="dbx-sess">
      <thead>
        <tr>
          <th>SID</th>
          <th>用户 / 机器</th>
          <th>状态</th>
          <th>等待</th>
          <th>锁</th>
          <th>SQL</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.sid}-${r.serial ?? 0}`} data-blocked={r.blocker != null || undefined}>
            <td>
              <button type="button" className="dbx-lk" aria-label={`查看会话 ${r.sid}`} onClick={()=>onSelect(r)}><b>{r.sid}</b></button>
              {r.blocker != null && <span className="dbx-sess-blk" title="被这个 SID 阻塞">←{r.blocker}</span>}
            </td>
            <td title={`${r.user} @ ${r.machine} · ${r.program}`}>
              <span className="u">{r.user || "-"}</span>
              <span className="m">{r.machine || r.program || "-"}</span>
            </td>
            <td>
              <span className="s">{r.status}</span>
              {r.elapsedSec > 0 && <span className="m">{r.elapsedSec}s</span>}
            </td>
            <td title={r.event}>
              <span className="e">{r.event || "-"}</span>
              {r.waitSec > 0 && <span className="m">等 {r.waitSec}s</span>}
            </td>
            <td>
              {r.locked.length === 0 ? (
                <span className="m">-</span>
              ) : (
                r.locked.map((o) => (
                  <span key={o} className="dbx-sess-obj" title={o}>
                    {o}
                  </span>
                ))
              )}
            </td>
            <td>
              <code
                title={
                  r.sql
                    ? r.sql
                    : r.sqlId
                      ? `这个账号读不到 SQL 文本（v$sql），只有 sql_id ${r.sqlId}`
                      : ""
                }
              >
                {r.sql || r.sqlId || "-"}
              </code>
              <span className="acts">
                {r.sql && (
                  <button type="button" className="dbx-lk" onClick={() => onCopy(r.sql, " SQL")}>
                    复制 SQL
                  </button>
                )}
                <button
                  type="button"
                  className="dbx-lk"
                  title="只复制语句，不执行"
                  onClick={() => onCopy(`alter system kill session '${r.sid},${r.serial ?? 0}';`, " KILL 语句")}
                >
                  复制 KILL
                </button>
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
