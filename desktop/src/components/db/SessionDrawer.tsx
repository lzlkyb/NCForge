import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { dbApi, type SessionRow } from "../../lib/dbApi";
import { friendlyDbError } from "../../lib/db";
import { useAppHidden } from "../../lib/appVisibility";
import { beginOperation } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
import { copyText } from "../../lib/utils";

/**
 * 自动刷新间隔。10 秒够看清「谁锁了谁」，也是共用库上 `v$session` + `v$locked_object`
 * 能长期开着的节奏——之前 5 秒在切走页面后仍在查，等于白给数据库加压。
 */
const REFRESH_MS = 10_000;

/** 读不到 `v$locked_object` 时给用户看的授权语句（**不代执行**，权限是 DBA 的事）。 */
const GRANT_HINT = "grant select on v$locked_object to <你的账号>;";

/**
 * 会话与锁（只读）。对标 PL/SQL Developer 的 Session/Lock 窗口。
 *
 * 定位只有一句：**30 秒内搞清楚"谁锁了这张表、在跑什么、该找谁"**。
 * 所以这里只读、只生成语句，不提供「一键杀」——`ALTER SYSTEM KILL SESSION` 二开账号
 * 通常没权限，生产库误杀还会打断别人的补丁执行。
 *
 * `granted: false` 时必须显式提示缺授权：把"看不见锁"显示成"没有锁"是这类面板最坏的 bug。
 */
export function SessionDrawer({ connId, onClose, visible = true }: { connId: string; onClose: () => void; visible?: boolean }) {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [granted, setGranted] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [at, setAt] = useState(0);

  const [loading,setLoading]=useState(false);
  const lock=useRef(false);
  const load = useCallback(async (observed=true) => {
    if(lock.current) return;lock.current=true;setLoading(true);
    const task=observed ? beginOperation(dbTaskSpec(`sessions:${connId}`,"读取数据库会话与锁",connId,"会话诊断")) : null;
    try {
      const r = await dbApi.sessions(connId);
      setRows(r.rows ?? []);
      // 后端没给 granted 时按「有」处理：老 jar 的返回里没这个字段
      setGranted(r.granted !== false);
      setErr(null);
      setAt(Date.now());
      task?.finish("success",r.granted===false ? "会话已读取；账号无权读取完整锁信息" : `已读取 ${r.rows?.length ?? 0} 个会话`);
    } catch (e) {
      task?.finish("failed","会话查询失败，返回数据库会话面板查看原因");
      setErr(friendlyDbError(e));
      setRows(null);
    } finally {lock.current=false;setLoading(false);}
  }, [connId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 抽屉是 store 级状态（按连接记），切文档标签不关；所以「看不见」有两层：
  // 窗口/页面不可见（`useAppHidden`），以及抽屉所在标签被别的文档盖住（`visible`）。
  // 两者任一为假都必须停轮询（CLAUDE.md 8.1：自动行为不可见即停）。
  const appHidden = useAppHidden();
  const paused = !auto || appHidden || !visible;

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => void load(false), REFRESH_MS);
    return () => clearInterval(t);
  }, [paused, load]);

  const copy = (text: string, what: string) => {
    if (!text) return;
    void copyText(text, () => toast(`已复制${what}`, "success"), (e) => toast(`复制失败：${e}`, "error"));
  };

  const blocked = (rows ?? []).filter((r) => r.blocker != null).length;

  return (
    <div className="dbx-drawer sess">
      <div className="hd">
        <Icon name="lock" size={14} />
        会话与锁
        <span className="dbx-cnt">{rows?.length ?? 0}</span>
        {blocked > 0 && <span className="dbx-sess-bad">阻塞 {blocked}</span>}
        <span className="dbx-sp" />
        <button type="button" className="dbx-ibtn" title="刷新" aria-label="刷新会话" disabled={loading} onClick={() => void load()}>
          <Icon name="refresh" size={13} />
        </button>
        <button
          type="button"
          className="dbx-ibtn"
          data-on={auto || undefined}
          title={auto ? "每 10 秒自动刷新（点击关闭）" : "已关闭自动刷新（点击开启）"}
          aria-label="自动刷新"
          onClick={() => setAuto(!auto)}
        >
          <Icon name="activity" size={13} />
        </button>
        <button type="button" className="dbx-ibtn" aria-label="关闭会话面板" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>

      {!granted && (
        <div className="dbx-sess-warn">
          <Icon name="alert" size={13} />
          <span>
            这个账号读不到 <code>v$locked_object</code>，<b>锁信息不可见</b>（不等于没有锁）。
            需要 DBA 执行：<code>{GRANT_HINT}</code>
          </span>
          <button type="button" className="dbx-lk" onClick={() => copy(GRANT_HINT, "授权语句")}>
            复制
          </button>
        </div>
      )}

      {err && <div className="dbx-err" style={{ margin: 8 }}>{err}</div>}

      <div className="list">
        {!rows && !err && <p className="dbx-tree-note">读取中…</p>}
        {rows && rows.length === 0 && <p className="dbx-tree-note">当前没有正在执行或被阻塞的会话</p>}
        {rows && rows.length > 0 && (
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
                    <b>{r.sid}</b>
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
                        <button type="button" className="dbx-lk" onClick={() => copy(r.sql, " SQL")}>
                          复制 SQL
                        </button>
                      )}
                      <button
                        type="button"
                        className="dbx-lk"
                        title="只复制语句，不执行"
                        onClick={() =>
                          copy(`alter system kill session '${r.sid},${r.serial ?? 0}';`, " KILL 语句")
                        }
                      >
                        复制 KILL
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="dbx-sess-foot">
        {at > 0 && <span>更新于 {new Date(at).toLocaleTimeString()}</span>}
        <span className="dbx-sp" />
        <span>只读 · 不代执行 KILL</span>
      </div>
    </div>
  );
}
