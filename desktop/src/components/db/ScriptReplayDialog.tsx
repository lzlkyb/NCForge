import { useRef } from "react";
import "../../db-console.css";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { downloadText } from "../../lib/resultExport";
import { connOf, type SqlTab } from "../../lib/dbStore";
import { ENV_LABEL } from "../../lib/dbApi";
import { isWrite } from "../../lib/sqlSplit";
import { failuresToSql, useScriptReplay } from "../../lib/scriptReplay";

const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

const firstLine = (sql: string) => sql.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";

/**
 * 回放 `.sql` 文件：读文件（UTF-8 / GBK）→ 切语句 → 在当前标签的会话里逐条执行。
 *
 * 为什么不把脚本读进编辑器再点「执行脚本」：编辑器只有一个页签，几百上千行的迁移
 * 脚本会把正在调的东西顶掉；而且现场脚本多是 GBK，编辑器里直接粘会乱码。
 * 这里读文件、定编码、切分都在前端完成，执行仍走 `runStatements`（生产库确认、
 * 事务状态、出错定位都与「执行脚本」同一套规则）。
 */
export function ScriptReplayDialog({ tab, onClose }: { tab: SqlTab; onClose: () => void }) {
  const conn = tab.connId ? connOf(tab.connId) : null;
  const { state, ignoreErrors, setIgnoreErrors, pick, run, cancel, reset } = useScriptReplay(tab);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const running = state.phase === "running";
  const close = () => {
    if (!running) onClose();
  };

  const file = state.phase === "idle" ? null : state.file;
  const writes = file ? file.stmts.filter((s) => isWrite(s.text)).length : 0;
  const prog = state.phase === "running" ? state.progress : null;
  const outcome = state.phase === "done" ? state.outcome : null;
  const pct = prog && prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : 0;

  const exportFailures = () => {
    if (!file || !outcome || outcome.failures.length === 0) return;
    const base = file.name.replace(/\.sql$/i, "");
    downloadText(`${base}.failed.sql`, failuresToSql(outcome.failures, file.name), "text/plain", false);
    toast(`已导出 ${outcome.failures.length} 条失败语句`, "success");
  };

  return (
    <Modal keepMountedWhenInactive
      open
      onClose={close}
      closeOnOverlay={!running}
      className="modal-surface dbx-dlg wide dbx-sr"
      ariaLabel="回放 SQL 脚本"
    >
      <div className="hd">
        <Icon name="terminal" size={16} />
        回放 SQL 脚本
        <span className="dbx-muted" style={{ fontWeight: 400, fontSize: 12 }}>
          {conn?.name ?? "未选连接"} · {conn?.user ?? ""}
          {conn ? ` · ${ENV_LABEL[conn.env]}` : ""}
        </span>
      </div>

      <div className="bd one">
        <div className="dbx-sr-pick">
          <button type="button" className="dbx-btn" disabled={running} onClick={() => fileRef.current?.click()}>
            <Icon name="folder" size={12} />
            选择 .sql 文件
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".sql,text/plain"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void pick(f);
            }}
          />
          {file ? (
            <span className="dbx-sr-file" title={file.name}>
              <b>{file.name}</b>
              <span className="dbx-muted">
                {file.stmts.length} 条语句 · {file.encoding} · {fmtSize(file.bytes)}
              </span>
            </span>
          ) : (
            <span className="dbx-muted">UTF-8 读不出来会自动按 GBK 再读一次</span>
          )}
        </div>

        {state.phase === "idle" && state.error && (
          <div className="dbx-sr-alert" data-tone="bad">
            <Icon name="alertTriangle" size={14} />
            <span>{state.error}</span>
          </div>
        )}

        {file && (
          <div className="dbx-sr-preview">
            <div className="dbx-sr-caption">前几条语句</div>
            <ol>
              {file.stmts.slice(0, 3).map((s) => (
                <li key={`${s.startLine}-${s.start}`}>
                  <span className="dbx-muted">第 {s.startLine} 行</span>
                  <code className="dbx-mono">{firstLine(s.text) || "(空)"}</code>
                </li>
              ))}
            </ol>
            {file.stmts.length > 3 && (
              <div className="dbx-muted">… 共 {file.stmts.length} 条，按原文顺序执行</div>
            )}
          </div>
        )}

        {file && conn?.env === "prod" && writes > 0 && (
          <div className="dbx-sr-alert" data-tone="warn">
            <Icon name="alert" size={14} />
            <span>
              生产库：脚本里有 <b>{writes}</b> 条会改数据或结构的语句。执行时每条写语句会要求确认
              （确认框里可以勾选「10 分钟内不再提醒」）。
            </span>
          </div>
        )}

        {file && (
          <label className="dbx-sr-opt">
            <input
              type="checkbox"
              checked={ignoreErrors}
              disabled={running}
              onChange={(e) => setIgnoreErrors(e.target.checked)}
            />
            <span>
              出错后继续执行剩余语句
              <span className="dbx-muted">
                （失败会逐条记下来；不勾就出错即停，后续语句不执行）
              </span>
            </span>
          </label>
        )}

        {prog && (
          <div className="dbx-sr-prog" role="status">
            <div className="dbx-sr-progtext">
              <Icon name="spinner" size={12} />
              <span>
                {prog.done}/{prog.total} 条 · 正在执行第 {prog.line} 行
              </span>
              <span className="dbx-sp" />
              <button type="button" className="dbx-btn bad" onClick={cancel}>
                <Icon name="stop" size={12} />
                停止
              </button>
            </div>
            <code className="dbx-mono dbx-sr-current">{firstLine(prog.text) || "(空)"}</code>
            <div className="dbx-sr-bar" aria-hidden>
              <i style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        {outcome && file && (
          <div className="dbx-sr-result">
            <div className="dbx-sr-sum">
              <Icon name={outcome.failures.length ? "alertTriangle" : "check"} size={14} />
              <span>
                执行了 <b>{outcome.done}</b>/{file.stmts.length} 条，成功{" "}
                <b>{outcome.done - outcome.failures.length}</b> 条
                {outcome.failures.length > 0 && (
                  <>
                    ，失败 <b>{outcome.failures.length}</b> 条
                  </>
                )}
              </span>
              <span className="dbx-sp" />
              {outcome.failures.length > 0 && (
                <button type="button" className="dbx-btn ghost" onClick={exportFailures}>
                  <Icon name="download" size={12} />
                  导出失败语句
                </button>
              )}
            </div>
            {outcome.stoppedByUser && (
              <div className="dbx-sr-alert" data-tone="warn">
                <Icon name="alert" size={14} />
                <span>生产库确认被取消，后面的语句没有执行。</span>
              </div>
            )}
            {outcome.failures.length > 0 && (
              <div className="dbx-sr-fails">
                <table className="dbx-sr-table">
                  <thead>
                    <tr>
                      <th>条</th>
                      <th>行</th>
                      <th>错误</th>
                      <th>语句</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outcome.failures.map((f) => (
                      <tr key={`${f.index}-${f.line}`}>
                        <td>{f.index}</td>
                        <td>{f.line}</td>
                        <td className="dbx-sr-err">{f.error}</td>
                        <td>
                          <code className="dbx-mono dbx-sr-sql">{firstLine(f.text)}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="dbx-muted dbx-sr-hint">
              脚本里的改动还在当前标签的事务里：去下面的「事务」条提交或回滚。
            </div>
          </div>
        )}
      </div>

      <div className="ft">
        <span className="dbx-muted">逐条执行 · 与「执行脚本」同一套生产库确认</span>
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn" disabled={running} onClick={close}>
          关闭
        </button>
        {file && !running && (
          <button type="button" className="dbx-btn" onClick={reset} title="清掉已选文件，重新选一个">
            重选
          </button>
        )}
        <button
          type="button"
          className="dbx-btn pri"
          disabled={running || !file}
          onClick={() => void run()}
        >
          <Icon name="play" size={12} />
          {state.phase === "done" ? "再跑一次" : running ? "执行中…" : "开始回放"}
        </button>
      </div>
    </Modal>
  );
}
