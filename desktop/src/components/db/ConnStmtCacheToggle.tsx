/**
 * 「关闭语句缓存」开关（连接表单的 Rust 引擎段）。
 *
 * 从 `ConnManualForm` 抽出来只为守住 300 行体量红线：逻辑原样搬走，一字未改。
 *
 * 背景：vendor 的 oracledb 驱动带语句缓存，表结构变过之后缓存里的列定义会过期，
 * 服务端按新结构回行、客户端按旧结构解析，字节流错位（`unknown TTC message type`，
 * 且连接永久损坏）。Oracle 官方对这个问题的建议就是把缓存关掉；自动对齐补丁之外，
 * 这里给用户一个手动兜底开关。
 */
export function ConnStmtCacheToggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <>
      <label className="dbx-chk">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        关闭语句缓存
      </label>
      <p className="dbx-hint">
        {checked
          ? "已关闭：每条语句都会重新解析、不再复用预处理结果，查询略慢，但不会出现「响应解析错位」（表结构变过后命中旧缓存才会发生）。"
          : "开着（推荐）：同样的 SQL 会复用预处理结果，宽表翻页更快。万一反复出现「数据库会话已断开 / unknown TTC message type」，勾上它——表结构变过之后缓存里的列定义会过期，服务端按新结构回行、客户端按旧结构解析，字节流就错位了。Oracle 官方对这个问题的建议也是把缓存关掉。"}
      </p>
    </>
  );
}
