import { useState } from "react";
import { Icon } from "../ui/icon";
import { EnvChips } from "./EnvChips";
import { friendlyDbError, thousands } from "../../lib/db";
import { buildOracleUrl, dbApi, parseOracleUrl, type DbConn, type DbConnInput, type DbEngine, type DbEnv, type TestResult } from "../../lib/dbApi";
import { closeConnDialog, disconnect, loadConns, rtOf } from "../../lib/dbStore";

interface Form {
  name: string;
  env: DbEnv;
  host: string;
  port: string;
  service: string;
  sid: boolean;
  url: string;
  user: string;
  password: string;
  remember: boolean;
  autoCommit: boolean;
  note: string;
  engine: DbEngine;
}

function initial(conn: DbConn | null): Form {
  const p = conn ? parseOracleUrl(conn.url) : null;
  return {
    name: conn?.name ?? "",
    env: conn?.env ?? "test",
    host: p?.host ?? "",
    port: p?.port ?? "1521",
    service: p?.service ?? "",
    sid: p?.sid ?? false,
    url: conn?.url ?? "",
    user: conn?.user ?? "",
    password: "",
    remember: true,
    autoCommit: conn?.autoCommit ?? false,
    note: conn?.note ?? "",
    engine: conn?.engine ?? "java",
  };
}

/**
 * 手动填写（新建或编辑）。主机 / 端口 / 服务名与 JDBC URL 两种写法互相同步。
 *
 * 来自 prop.xml 的连接只能改名称 / 环境 / 事务模式 / 引擎：连接串与口令跟着 prop.xml 走。
 * 选纯 Rust 驱动时，口令会在第一次连接时由 JVM 桥解一次并加密存本机（之后不再需要 JVM）。
 */
export function ConnManualForm({ conn }: { conn: DbConn | null }) {
  const [f, setF] = useState<Form>(() => initial(conn));
  const [test, setTest] = useState<{ ok?: TestResult; err?: string; busy?: boolean }>({});
  const [saving, setSaving] = useState(false);
  const fromProp = conn?.source === "prop";

  const put = (patch: Partial<Form>) => {
    const next = { ...f, ...patch };
    if ("host" in patch || "port" in patch || "service" in patch || "sid" in patch) {
      next.url = next.host && next.service ? buildOracleUrl(next.host, next.port, next.service, next.sid) : "";
    } else if ("url" in patch) {
      const p = parseOracleUrl(next.url);
      if (p) Object.assign(next, { host: p.host, port: p.port, service: p.service, sid: p.sid });
    }
    setF(next);
    setTest({});
  };

  const input = (): DbConnInput => ({
    id: conn?.id ?? null,
    name: f.name.trim(),
    env: f.env,
    source: conn?.source ?? "manual",
    url: f.url.trim(),
    user: f.user.trim(),
    propDs: conn?.propDs ?? null,
    autoCommit: f.autoCommit,
    note: f.note.trim() || null,
    engine: f.engine,
  });

  const missing = !f.url.trim() ? "连接串" : !f.user.trim() ? "用户名" : null;

  const runTest = async () => {
    setTest({ busy: true });
    try {
      setTest({ ok: await dbApi.test(input(), f.password || undefined) });
    } catch (e) {
      setTest({ err: friendlyDbError(e) });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const target = conn && (conn.url !== f.url.trim() || conn.user !== f.user.trim() || conn.engine !== input().engine);
      await dbApi.save(input(), f.password || undefined, f.remember);
      // 连接串、用户或引擎变了：旧会话已经不是这个连接了，断掉重连
      if (target && conn && rtOf(conn.id).status === "connected") await disconnect(conn.id);
      await loadConns();
      closeConnDialog();
    } catch (e) {
      setTest({ err: friendlyDbError(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="bd">
        <label>名称</label>
        <input className="dbx-inp" value={f.name} placeholder="留空则用服务名" onChange={(e) => put({ name: e.target.value })} />
        <label>环境</label>
        <EnvChips value={f.env} onChange={(env) => put({ env })} />
        {fromProp ? (
          <>
            <label>连接串</label>
            <span className="dbx-mono">{f.url}</span>
            <label>用户</label>
            <span className="dbx-mono">{f.user}</span>
            <p className="dbx-hint">来自 NC prop.xml 的数据源 {conn?.propDs}：连接串与口令跟着 prop.xml 走，每次连接时由 NC 自带的类解密。</p>
          </>
        ) : (
          <>
            <label>主机</label>
            <div className="dbx-row2">
              <input className="dbx-inp mono" value={f.host} placeholder="10.200.22.144" onChange={(e) => put({ host: e.target.value })} />
              <input className="dbx-inp mono" value={f.port} placeholder="1521" onChange={(e) => put({ port: e.target.value })} />
            </div>
            <label>{f.sid ? "SID" : "服务名"}</label>
            <div className="dbx-row2">
              <input className="dbx-inp mono" value={f.service} onChange={(e) => put({ service: e.target.value })} />
              <label className="dbx-chk">
                <input type="checkbox" checked={f.sid} onChange={(e) => put({ sid: e.target.checked })} />
                SID 写法
              </label>
            </div>
            <label>JDBC URL</label>
            <input className="dbx-inp mono" value={f.url} placeholder="jdbc:oracle:thin:@host:1521/service" onChange={(e) => put({ url: e.target.value })} />
            <label>用户</label>
            <input className="dbx-inp mono" value={f.user} onChange={(e) => put({ user: e.target.value })} />
            <label>口令</label>
            <div className="dbx-row2" style={{ gridTemplateColumns: "1fr auto" }}>
              <input
                className="dbx-inp"
                type="password"
                value={f.password}
                placeholder={conn?.hasPassword ? "已保存，不改就留空" : ""}
                onChange={(e) => put({ password: e.target.value })}
              />
              <label className="dbx-chk">
                <input type="checkbox" checked={f.remember} onChange={(e) => put({ remember: e.target.checked })} />
                记住
              </label>
            </div>
          </>
        )}
        <label>引擎</label>
        <div className="dbx-txmode" style={{ justifySelf: "start" }}>
          <button type="button" data-on={f.engine === "java" || undefined} onClick={() => put({ engine: "java" })}>
            JVM 桥
          </button>
          <button type="button" data-on={f.engine === "rust" || undefined} onClick={() => put({ engine: "rust" })}>
            纯 Rust 驱动
          </button>
        </div>
        <p className="dbx-hint">
          {f.engine === "rust"
            ? fromProp
              ? "纯 Rust 驱动：每条连接只占几 MB。prop.xml 里的口令会在第一次连接时由 JVM 桥解一次、加密存在本机，之后不再依赖 JVM。代价是没有 REF CURSOR。"
              : "纯 Rust 驱动：每条连接只占几 MB（JVM 桥光底价就 60MB 以上）。代价是没有 REF CURSOR。"
            : fromProp
              ? "JVM 桥：prop.xml 的口令每次现解、不落盘，这是默认选项。"
              : "JVM 桥：能力最全（支持 REF CURSOR、能解 prop.xml 口令），多条连接共用一个 JVM。"}
        </p>
        <label>事务</label>
        <div className="dbx-txmode" style={{ justifySelf: "start" }}>
          <button type="button" data-on={!f.autoCommit || undefined} onClick={() => put({ autoCommit: false })}>
            手动提交
          </button>
          <button type="button" data-on={f.autoCommit || undefined} onClick={() => put({ autoCommit: true })}>
            自动提交
          </button>
        </div>
        <label>备注</label>
        <input className="dbx-inp" value={f.note} onChange={(e) => put({ note: e.target.value })} />
        {test.ok && (
          <div className="dbx-okline">
            <Icon name="check" size={13} />
            连接成功 · {test.ok.product} {test.ok.version} · {test.ok.ms} ms
            {test.ok.tables !== null && <> · 该用户下 {thousands(test.ok.tables)} 张表</>}
          </div>
        )}
        {test.err && (
          <div className="dbx-badline">
            <Icon name="alert" size={13} />
            <span>{test.err}</span>
          </div>
        )}
      </div>
      <div className="ft">
        <button type="button" className="dbx-btn" disabled={!!missing || test.busy} onClick={() => void runTest()}>
          <Icon name={test.busy ? "spinner" : "plug"} size={12} />
          {test.busy ? "测试中…" : "测试连接"}
        </button>
        {missing && <span className="dbx-muted">还缺{missing}</span>}
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn" onClick={closeConnDialog}>
          取消
        </button>
        <button type="button" className="dbx-btn pri" disabled={!!missing || saving} onClick={() => void save()}>
          {conn ? "保存" : "添加"}
        </button>
      </div>
    </>
  );
}
