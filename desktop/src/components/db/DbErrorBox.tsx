import { Icon } from "../ui/icon";
import { oraCode, similarTo, tableRefs } from "../../lib/db";

/**
 * 执行失败的说明。
 *
 * ORA-00942（表不存在）是最常见的错，而且往往只是手滑：给出库里相近的表名，
 * 点一下复制。其它错误原样给 ORA 文案，保留错误号给 DBA。
 */
export function DbErrorBox({ error, sql, knownTables, index }: {
  error: string;
  sql: string;
  knownTables: string[];
  /** 脚本里的第几条。 */
  index?: number;
}) {
  const ora = oraCode(error);
  const suggestions =
    ora === "ORA-00942" ? [...new Set(tableRefs(sql).flatMap((t) => similarTo(t, knownTables, 2)))].slice(0, 3) : [];
  return (
    <div className="dbx-err">
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
        <Icon name="alert" size={13} />
        {index ? `第 ${index} 条执行失败` : "执行失败"}
        {ora && <span className="dbx-mono">{ora}</span>}
      </div>
      <div style={{ marginTop: 4, wordBreak: "break-all" }}>{error}</div>
      {ora === "ORA-01031" && <div style={{ marginTop: 4 }}>当前账号没有这个操作的权限（读写权限由数据库账号决定）。</div>}
      {suggestions.length > 0 && (
        <div style={{ marginTop: 4 }}>
          库里相近的表名（点击复制）：
          {suggestions.map((s) => (
            <code key={s} onClick={() => void navigator.clipboard.writeText(s.toLowerCase())}>
              {s.toLowerCase()}
            </code>
          ))}
        </div>
      )}
      <pre>{sql}</pre>
    </div>
  );
}
