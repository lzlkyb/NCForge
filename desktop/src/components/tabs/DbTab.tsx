import { useMemo, useRef, useState } from "react";
import "../../db.css";
import { Icon } from "../ui/icon";
import { ResultGrid } from "../db/ResultGrid";
import { DbErrorBox } from "../db/DbErrorBox";
import { ConnectDialog } from "../db/ConnectDialog";
import { useDbSession } from "../../hooks/useDbSession";
import { friendlyDbError, parseDbError, splitJdbcUrl, thousands } from "../../lib/db";

const SAMPLE = `select m.code, m.name, m.materialmny as 单价
from bd_material m
where m.code like 'CL04%'
order by m.code`;

/**
 * 数据库页（只读 SQL）。
 *
 * 布局照 design/NCForge-补丁与数据库-设计稿-2026-10-28.html：
 * 顶栏连接胶囊 → 工具条 → SQL 编辑区 → 结果表。
 *
 * **只读由 Java 桥三道光保证**（语句白名单 / `SET TRANSACTION READ ONLY` / 执行后 rollback），
 * 这个页面不做任何「写操作」的入口——连按钮都不给。
 */
export function DbTab() {
  const s = useDbSession();
  const [sql, setSql] = useState(SAMPLE);
  const [maxRows, setMaxRows] = useState(500);
  const [timeoutSec, setTimeoutSec] = useState(30);
  const [manualOpen, setManualOpen] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const lines = useMemo(() => sql.split("\n").length, [sql]);
  const knownTables = useMemo(() => (s.tables.data ?? []).map((t) => t.name), [s.tables.data]);
  const url = s.defaults.data?.url ?? "";
  const user = s.defaults.data?.user ?? "";
  const target = splitJdbcUrl(url);

  const run = () => {
    if (!s.conn) {
      setManualOpen(true);
      return;
    }
    void s.run(sql, maxRows, timeoutSec);
  };

  // 存过口令就直接连（零点击）；没存过或想换口令才弹框。
  // 「一进页面就连」被刻意排除：万一 prop.xml 指着生产库，那会变成
  // 「点开一个标签页就多了一个生产会话」。
  const onConnect = () => {
    if (s.conn || !s.defaults.data?.hasPassword) {
      setManualOpen(true);
      return;
    }
    void s.connect();
  };

  const connErr = s.connError ? friendlyDbError(s.connError) : null;
  const authFailed = s.connError ? parseDbError(s.connError).code === "auth" : false;

  return (
    <div className="dq-page">
      <div className="dq-top">
        <h1>数据库</h1>
        {s.conn ? (
          <span className="dq-conn" title={s.conn.url}>
            <span className="dot" data-on />
            <b>
              {target.host}/{target.database}
            </b>
            <span className="u">{s.conn.user}</span>
          </span>
        ) : (
          <span className="dq-conn" data-off>
            <span className="dot" />
            未连接
          </span>
        )}
        {s.conn && <span className="dq-ro">只读会话</span>}
        <span className="dq-sp" />
        {s.conn && (
          <span className="dq-kv">
            表结构 <b>{s.tables.isFetching ? "读取中…" : thousands(s.tables.data?.length ?? 0)}</b> 表
          </span>
        )}
        <button
          type="button"
          className="dq-btn"
          disabled={s.connecting}
          onClick={onConnect}
          title={s.defaults.data?.passwordNeedsInput ? "首次连接要输一次密码" : "换个库 / 重输口令"}
        >
          <Icon name="key" size={12} />
          {s.conn ? "换连接" : s.connecting ? "连接中…" : "连接"}
        </button>
        {s.conn && (
          <button type="button" className="dq-btn" onClick={() => void s.disconnect()}>
            <Icon name="power" size={12} />
            断开
          </button>
        )}
      </div>

      {!s.defaults.data?.driverFound && s.defaults.data !== undefined && (
        <div className="dq-banner" data-tone="warn">
          <Icon name="alertTriangle" size={13} />
          <span>
            NC home 的 driver 目录下没找到 Oracle 驱动（<code>driver/oracle_11g/ojdbc6.jar</code>
            ）——先在设置页把 NC home 指对。
          </span>
        </div>
      )}
      {connErr && !s.askPassword && (
        <div className="dq-banner" data-tone="bad">
          <Icon name="alert" size={13} />
          <span>{connErr}</span>
          {authFailed && (
            <button type="button" className="dq-link" onClick={() => setManualOpen(true)}>
              重新输入
            </button>
          )}
        </div>
      )}

      <div className="dq-body">
        <div className="dq-tools">
          <label className="dq-num">
            行上限
            <input
              type="number"
              min={10}
              max={2000}
              value={maxRows}
              onChange={(e) => setMaxRows(Math.max(10, Math.min(2000, Number(e.target.value) || 500)))}
            />
          </label>
          <label className="dq-num">
            超时
            <input
              type="number"
              min={5}
              max={120}
              value={timeoutSec}
              onChange={(e) => setTimeoutSec(Math.max(5, Math.min(120, Number(e.target.value) || 30)))}
            />
            s
          </label>
          <span className="dq-sp" />
          <span className="dq-muted">单条 select / with，多了直接拒</span>
          <button
            type="button"
            className="dq-btn dq-btn-primary"
            disabled={s.running || !s.conn}
            title="Ctrl+Enter"
            onClick={run}
          >
            <Icon name="play" size={12} />
            {s.running ? "执行中…" : "执行"}
          </button>
        </div>

        <div className="dq-sqlbox">
          <div className="dq-gutter" aria-hidden>
            {Array.from({ length: Math.max(lines, 1) }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <textarea
            ref={areaRef}
            className="dq-code"
            value={sql}
            spellCheck={false}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                run();
              }
            }}
          />
        </div>

        {s.queryError && <DbErrorBox error={s.queryError} sql={sql} knownTables={knownTables} />}

        {s.result ? (
          <ResultGrid data={s.result} />
        ) : (
          <div className="dq-empty">
            <Icon name="database" size={22} />
            <span>
              {s.conn
                ? "写好 SQL 按 Ctrl+Enter 执行。结果最多 500 行，超了只显示前 500 行"
                : "先点右上角「连接」"}
            </span>
          </div>
        )}
      </div>

      <ConnectDialog
        open={s.askPassword || manualOpen}
        url={url}
        user={user}
        source={s.defaults.data?.source ?? ""}
        busy={s.connecting}
        error={s.connError ? friendlyDbError(s.connError) : null}
        onClose={() => {
          setManualOpen(false);
          s.setAskPassword(false);
        }}
        onSubmit={async (pw) => {
          const ok = await s.connect(pw);
          if (ok) setManualOpen(false);
        }}
      />
    </div>
  );
}
