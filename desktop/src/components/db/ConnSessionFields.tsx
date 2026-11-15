import { useId } from "react";

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
      <label htmlFor={keepId}>主连接保活</label>
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

      <label htmlFor={initId}>启动脚本</label>
      <textarea
        id={initId}
        className="dbx-inp mono dbx-initsql"
        rows={3}
        value={props.initSql}
        placeholder={"alter session set nls_date_format='YYYY-MM-DD HH24:MI:SS'"}
        onChange={(e) => props.onInitSql(e.target.value)}
      />
      <p className="dbx-hint">连接或自动重连后执行。</p>
    </>
  );
}
