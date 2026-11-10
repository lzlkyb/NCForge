import { useId } from "react";

/**
 * 连接表单的「会话维持」一节：空闲保活间隔 + 启动脚本。
 *
 * 抽成独立组件的理由与 `ConnGroupColorFields` 一样：`ConnManualForm` 已经顶到 300 行上限，
 * 再往里塞两个字段就会超。
 *
 * 这两项解决的是同一件事的**两端**：保活让会话别被防火墙 / `SQLNET.EXPIRE_TIME` 收掉；
 * 真被收掉了（网络中断、DBA 杀了会话），重连出来是一条**新会话**，旧会话上的
 * `ALTER SESSION`（`NLS_DATE_FORMAT`、时区、`SET ROLE`）与包状态都没了——启动脚本
 * 负责把它们补回来。
 */

/** 保活间隔可选项（秒）。`0` = 关闭。与后端 `db_conns::normalize_keep_alive` 的夹边范围一致。 */
export const KEEP_ALIVE_CHOICES: { sec: number; label: string }[] = [
  { sec: 0, label: "关闭" },
  { sec: 60, label: "1 分钟" },
  { sec: 120, label: "2 分钟" },
  { sec: 240, label: "4 分钟（推荐）" },
  { sec: 600, label: "10 分钟" },
  { sec: 1800, label: "30 分钟" },
];

export function ConnSessionFields(props: {
  id: string;
  keepAliveSec: number;
  initSql: string;
  onKeepAlive: (sec: number) => void;
  onInitSql: (sql: string) => void;
}) {
  const formId = useId();
  const keepId = `${props.id}-keepalive`;
  const initId = `${formId}-initsql`;
  return (
    <>
      <label htmlFor={keepId}>空闲保活</label>
      <select
        id={keepId}
        className="dbx-inp"
        value={String(props.keepAliveSec)}
        onChange={(e) => props.onKeepAlive(Number(e.target.value))}
      >
        {KEEP_ALIVE_CHOICES.map((c) => (
          <option key={c.sec} value={c.sec}>
            {c.label}
          </option>
        ))}
      </select>
      <p className="dbx-hint">
        闲置超过这个时间就自动发一次探测，让会话别被防火墙或数据库收掉。默认 4 分钟，
        能挡住大多数 5 分钟级的空闲回收；关掉后闲置回来第一次操作可能要等一次重连。
        <b>只对主会话生效</b>，SQL 标签的独立会话照旧空闲回收。
      </p>
      <label htmlFor={initId}>启动脚本</label>
      <textarea
        id={initId}
        className="dbx-inp mono dbx-initsql"
        rows={3}
        value={props.initSql}
        placeholder={"alter session set nls_date_format='YYYY-MM-DD HH24:MI:SS'"}
        onChange={(e) => props.onInitSql(e.target.value)}
      />
      <p className="dbx-hint">
        连上、以及<b>断线自动重连之后</b>各执行一遍（多条用分号分隔，支持 <code>begin … end;</code> 块）。
        重连出来的是新会话，旧会话上的 <code>alter session</code> 与包状态不会跟着回来，靠这里补。
        某一条失败只提示、不会让连接失败。
      </p>
    </>
  );
}
