import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { EnvChips } from "./EnvChips";
import { friendlyDbError, parseDbError, thousands } from "../../lib/db";
import { buildOracleUrl, dbApi, parseOracleUrl, type DbConn, type DbConnInput, type DbEngine, type DbEnv, type TestResult } from "../../lib/dbApi";
import { ncHomeProbe } from "../../lib/server";
import { beginOperation } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
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
  /** 默认 schema：连上就切过去，写 SQL 不用带 `aier633.` 前缀。空 = 登录账号自己的。 */
  defaultSchema: string;
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
    engine: conn?.engine ?? "rust",
    defaultSchema: conn?.defaultSchema ?? "",
  };
}

/**
 * 手动填写（新建或编辑）。主机 / 端口 / 服务名与 JDBC URL 两种写法互相同步。
 *
 * 来自 prop.xml 的连接只能改名称 / 环境 / 事务模式 / 引擎：连接串与口令跟着 prop.xml 走。
 * 选纯 Rust 驱动时，口令会在第一次连接时由 JVM 桥解一次并加密存本机（之后不再需要 JVM）。
 */
export function ConnManualForm({ conn }: { conn: DbConn | null }) {
  const formId = useId();
  const fieldId = (field: string) => `${formId}-${field}`;
  const [f, setF] = useState<Form>(() => initial(conn));
  const [test, setTest] = useState<{ ok?: TestResult; err?: string; busy?: boolean }>({});
  const [saving, setSaving] = useState(false);
  const fromProp = conn?.source === "prop";
  /**
   * 这台机器有没有可用的 NC home。`null` = 还没探明。
   *
   * 只用来给 JVM 桥加标注（它要用 NC 自带的 Java 与 Oracle 驱动）——**不拦用户选**：
   * 配没配 home 是运行时的事，选错了也有 `need-nc-home` 错误接着，那条路给一键换引擎。
   */
  const [hasHome, setHasHome] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void ncHomeProbe().then(
      (h) => { if (alive) setHasHome(!!h.root); },
      () => { if (alive) setHasHome(false); },
    );
    return () => { alive = false; };
  }, []);

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
    defaultSchema: f.defaultSchema.trim() || null,
  });

  const missing = !f.url.trim() ? "连接串" : !f.user.trim() ? "用户名" : null;
  /**
   * 后端发的「需要 NC home」码：红条据此给出「换引擎」的一键出路，不让用户对着一段说明自己想办法。
   *
   * 解析的是**原始错误**（`code|message`），不是 `friendlyDbError` 之后的文案——那一步会把
   * `code|` 前缀剥掉，再解析就只剩 `other` 了（测试 `need-nc-home 红条给出一键出路` 守这条）。
   */
  const needHome = !!test.err && parseDbError(test.err).code === "need-nc-home" && f.engine !== "rust";

  const lock=useRef(false);
  const runTest = async () => {
    if(lock.current) return;
    const task=beginOperation(dbTaskSpec(`connection.form:${conn?.id || "new"}`,"测试数据库连接",conn?.id ?? null,"连接配置"));
    if(!task) return;lock.current=true;
    setTest({ busy: true });
    try {
      const ok=await dbApi.test(input(), f.password || undefined);
      task.finish("success","连接测试已通过");setTest({ok});
    } catch (e) {
      task.finish("failed","连接测试失败，返回连接配置查看原因");
      // 存原始错误（带 `code|` 前缀）：needHome 要解析它，显示时再 friendlyDbError
      setTest({ err: e instanceof Error ? e.message : String(e) });
    } finally {lock.current=false;}
  };

  const save = async () => {
    if(lock.current) return;
    const task=beginOperation(dbTaskSpec(`connection.form:${conn?.id || "new"}`,"保存数据库连接配置",conn?.id ?? null,"连接配置"));
    if(!task) return;lock.current=true;setSaving(true);
    try {
      const target = conn && (conn.url !== f.url.trim() || conn.user !== f.user.trim() || conn.engine !== input().engine || (conn.defaultSchema ?? "") !== f.defaultSchema.trim());
      await dbApi.save(input(), f.password || undefined, f.remember);
      // 连接串、用户或引擎变了：旧会话已经不是这个连接了，断掉重连
      if (target && conn && rtOf(conn.id).status === "connected") await disconnect(conn.id);
      await loadConns();
      task.finish("success","配置已保存");closeConnDialog();
    } catch (e) {
      task.finish("failed","配置保存失败，返回连接配置查看原因");
      setTest({ err: e instanceof Error ? e.message : String(e) });
    } finally {
      lock.current=false;setSaving(false);
    }
  };

  return (
    <>
      <div className="bd">
        <h3 className="dbx-form-section">基本信息</h3>
        <label htmlFor={fieldId("name")}>名称</label>
        <input id={fieldId("name")} className="dbx-inp" value={f.name} placeholder="留空则用服务名" onChange={(e) => put({ name: e.target.value })} />
        <span className="dbx-form-label">环境</span>
        <EnvChips value={f.env} onChange={(env) => put({ env })} />
        <h3 className="dbx-form-section">连接与认证</h3>
        {fromProp ? (
          <>
            <span className="dbx-form-label">连接串</span>
            <span className="dbx-mono">{f.url}</span>
            <span className="dbx-form-label">用户</span>
            <span className="dbx-mono">{f.user}</span>
            <p className="dbx-hint">来自 NC prop.xml 的数据源 {conn?.propDs}：连接串与口令跟着 prop.xml 走，每次连接时由 NC 自带的类解密。</p>
          </>
        ) : (
          <>
            <div className="dbx-form-label"><label htmlFor={fieldId("host")}>主机</label> / <label htmlFor={fieldId("port")}>端口</label></div>
            <div className="dbx-row2">
              <input id={fieldId("host")} className="dbx-inp mono" value={f.host} placeholder="10.200.22.144" onChange={(e) => put({ host: e.target.value })} />
              <input id={fieldId("port")} className="dbx-inp mono" value={f.port} placeholder="1521" onChange={(e) => put({ port: e.target.value })} />
            </div>
            <label htmlFor={fieldId("service")}>{f.sid ? "SID" : "服务名"}</label>
            <div className="dbx-row2">
              <input id={fieldId("service")} className="dbx-inp mono" value={f.service} onChange={(e) => put({ service: e.target.value })} />
              <label className="dbx-chk">
                <input type="checkbox" checked={f.sid} onChange={(e) => put({ sid: e.target.checked })} />
                SID 写法
              </label>
            </div>
            <label htmlFor={fieldId("url")}>JDBC URL</label>
            <input id={fieldId("url")} className="dbx-inp mono" value={f.url} placeholder="jdbc:oracle:thin:@host:1521/service" onChange={(e) => put({ url: e.target.value })} />
            <label htmlFor={fieldId("user")}>用户</label>
            <input id={fieldId("user")} className="dbx-inp mono" value={f.user} onChange={(e) => put({ user: e.target.value })} />
            <label htmlFor={fieldId("password")}>口令</label>
            <div className="dbx-row2" style={{ gridTemplateColumns: "1fr auto" }}>
              <input
                className="dbx-inp"
                type="password"
                id={fieldId("password")}
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
        <h3 className="dbx-form-section">运行方式</h3>
        <label htmlFor={fieldId("schema")}>默认 schema</label>
        <input
          id={fieldId("schema")}
          className="dbx-inp mono"
          value={f.defaultSchema}
          placeholder="例如 AIER633（留空 = 登录账号自己的）"
          onChange={(e) => put({ defaultSchema: e.target.value })}
        />
        <p className="dbx-hint">
          连上后立刻切换，之后写 <code>select * from org_orgs</code> 不用再带 <code>aier633.</code> 前缀。
          它只影响<b>不带前缀</b>的名字解析，不改变权限（查别人的表仍要那边授权）；会话里也可以随时用工具条上的 schema 胶囊临时切换。
        </p>
        <span className="dbx-form-label" id={fieldId("engine")}>引擎</span>
        <div className="dbx-txmode" role="group" aria-labelledby={fieldId("engine")} style={{ justifySelf: "start" }}>
          <button type="button" aria-pressed={f.engine === "rust"} data-on={f.engine === "rust" || undefined} onClick={() => put({ engine: "rust" })}>
            纯 Rust 驱动
          </button>
          <button
            type="button"
            aria-pressed={f.engine === "java"}
            data-on={f.engine === "java" || undefined}
            title={hasHome === false ? "需要 NC 安装目录（这台机器还没配置）" : undefined}
            onClick={() => put({ engine: "java" })}
          >
            JVM 桥
          </button>
        </div>
        <p className="dbx-hint">
          {f.engine === "rust"
            ? fromProp
              ? "纯 Rust 驱动：每条连接只占几 MB。prop.xml 里的口令会在第一次连接时由 JVM 桥解一次、加密存在本机，之后不再依赖 JVM。代价是没有 REF CURSOR。"
              : "纯 Rust 驱动：每条连接只占几 MB（JVM 桥光底价就 60MB 以上），且不依赖 NC home。代价是没有 REF CURSOR。"
            : fromProp
              ? "JVM 桥：prop.xml 的口令每次现解、不落盘，这是默认选项。"
              : hasHome === false
                ? "JVM 桥：能力最全（REF CURSOR、解 prop.xml 口令），但它要用 NC 自带的 Java 1.8 与 Oracle 驱动——这台机器还没配置 NC home，现在选它连不上。没有 NC home 的话用「纯 Rust 驱动」即可。"
                : "JVM 桥：能力最全（支持 REF CURSOR、能解 prop.xml 口令），多条连接共用一个 JVM；要用 NC 自带的 Java 与驱动，先在设置里配置 NC home。"}
        </p>
        <span className="dbx-form-label" id={fieldId("tx")}>事务</span>
        <div className="dbx-txmode" role="group" aria-labelledby={fieldId("tx")} style={{ justifySelf: "start" }}>
          <button type="button" aria-pressed={!f.autoCommit} data-on={!f.autoCommit || undefined} onClick={() => put({ autoCommit: false })}>
            手动提交
          </button>
          <button type="button" aria-pressed={f.autoCommit} data-on={f.autoCommit || undefined} onClick={() => put({ autoCommit: true })}>
            自动提交
          </button>
        </div>
        <p className="dbx-hint">新会话采用此设置。已打开的会话在处理完待提交写入、重新连接后生效。</p>
        <label htmlFor={fieldId("note")}>备注</label>
        <input id={fieldId("note")} className="dbx-inp" value={f.note} onChange={(e) => put({ note: e.target.value })} />
        {test.ok && (
          <div className="dbx-okline">
            <Icon name="check" size={13} />
            连接成功 · {test.ok.product} {test.ok.version} · {test.ok.ms} ms
            {test.ok.tables !== null && (
              <>
                {" "}· {test.ok.schema ? `${test.ok.schema} 下` : "该用户下"} {thousands(test.ok.tables)} 张表
              </>
            )}
          </div>
        )}
        {test.ok?.schemaWarning && (
          <div className="dbx-badline">
            <Icon name="alert" size={13} />
            <span>默认 schema 没生效，当前用的是登录账号：{test.ok.schemaWarning}</span>
          </div>
        )}
        {test.err && (
          <div className="dbx-badline">
            <Icon name="alert" size={13} />
            <span>{friendlyDbError(test.err)}</span>
            {needHome && (
              <button type="button" className="dbx-btn" style={{ flexShrink: 0, alignSelf: "center" }} onClick={() => put({ engine: "rust" })}>
                换成纯 Rust 驱动
              </button>
            )}
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
