import { Icon } from "../ui/icon";
import { friendlyDbError, oraCode, parseDbError, similarTo, tableRefs } from "../../lib/db";

/**
 * 查询失败的说明。
 *
 * 三种错要分开说，因为处理动作完全不同：
 * - ORA-00942 表名不存在 → 给相近表名（这是最常见的错，且用户往往确实只是手滑）；
 * - 我们自己的「只放行 select」→ 明确说**是工作台拦的**，不然用户会去查数据库权限；
 * - 其它 → 原样给 ORA 文案，保留错误号给 DBA。
 */
export function DbErrorBox({
  error,
  sql,
  knownTables,
}: {
  error: string;
  /** 出错那次提交的 SQL：ORA 消息里不带表名，得从语句里取。 */
  sql: string;
  knownTables: string[];
}) {
  const { code, message } = parseDbError(error);
  const ora = oraCode(message);
  const writeBlocked = /只放行|写操作|单条语句/.test(message);
  const isMissingTable = ora === "ORA-00942";
  // 表名写错时给出候选：对 SQL 里每个 from/join 的表名各找一次，去重后最多 3 条
  const suggestions = isMissingTable
    ? [...new Set(tableRefs(sql).flatMap((t) => similarTo(t, knownTables, 2)))].slice(0, 3)
    : [];

  return (
    <div className="dq-errbox" data-tone={writeBlocked ? "warn" : "bad"}>
      <div className="k">
        <Icon name={writeBlocked ? "alertTriangle" : "alert"} size={13} />
        {writeBlocked ? "写操作被拒绝（这条是工作台拦的，不是数据库报的）" : (ora ?? friendlyDbError(error))}
      </div>
      <div className="msg">{message}</div>
      {writeBlocked && (
        <div className="hint">
          SQL 面板只放行 <code>select</code> / <code>with</code> 开头的单条语句。要改数据请走正式脚本，
          别在这里试——这里有三层拦截（语句白名单 → 只读事务 → 执行后 rollback）。
        </div>
      )}
      {!writeBlocked && code === "unreachable" && (
        <div className="hint">检查 VPN / 网络是否通，以及数据库实例是不是起着。</div>
      )}
      {!writeBlocked && code === "auth" && (
        <div className="hint">口令存在本机（DPAPI），换机器或换 Windows 用户后要重新输一次。</div>
      )}
      {suggestions.length > 0 && (
        <div className="hint">
          表结构缓存里的相近表名：
          {suggestions.map((s) => (
            <code key={s}>{s}</code>
          ))}
        </div>
      )}
    </div>
  );
}
