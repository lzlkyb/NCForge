import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { BusyIndicator } from "../ui/BusyIndicator";
import { TaskFeedback } from "../ui/TaskFeedback";
import { toast } from "../ui/toast";
import { ConnAddressFields, isSimpleConnAddress } from "./ConnAddressFields";
import { ConnStmtCacheToggle } from "./ConnStmtCacheToggle";
import { ConnGroupColorFields } from "./ConnGroupColorFields";
import { ConnSessionFields } from "./ConnSessionFields";
import { ConnTestResult } from "./ConnTestResult";
import { parseDbError } from "../../lib/db";
import { dbApi, ENVS, ENV_LABEL, type DbConn, type DbConnInput, type TestResult } from "../../lib/dbApi";
import { initialConnForm, mergeConnForm, type DbConnForm } from "../../lib/dbConnForm";
import { groupNames } from "../../lib/dbConnGroups";
import { ncHomeProbe } from "../../lib/server";
import { beginOperation } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
import { closeConnDialog, connect, loadConns, rtOf, useDbConns } from "../../lib/dbStore";

export function ConnManualForm({ conn, onSaving }: { conn: DbConn | null; onSaving?: (saving: boolean) => void }) {
  const formId = useId();
  const fieldId = (field: string) => `${formId}-${field}`;
  const [f, setF] = useState<DbConnForm>(() => initialConnForm(conn));
  // 已有分组名，只用来给分组输入框做候选（`datalist`），不参与保存逻辑。
  const conns = useDbConns();
  const [test, setTest] = useState<{ ok?: TestResult; err?: string; busy?: boolean; saved?: boolean }>({});
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState(() => ({
    advanced: false, raw: !!f.url && !isSimpleConnAddress(f.url), invalid: null as string | null,
  }));
  const { advanced, raw, invalid } = view;
  const savedId = useRef<string | null>(null);
  const alive = useRef(false);
  const [testing, setTesting] = useState(false);
  const formVersion = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const fromProp = conn?.source === "prop";
  const [hasHome, setHasHome] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void ncHomeProbe().then(
      (h) => { if (alive) setHasHome(!!h.root); },
      () => { if (alive) setHasHome(false); },
    );
    return () => { alive = false; };
  }, []);

  const put = (patch: Partial<DbConnForm>) => {
    formVersion.current++;
    setF((cur) => mergeConnForm(cur, patch));
    setTest({});
    setView(current => ({ ...current, invalid: null }));
  };

  const input = (): DbConnInput => ({
    id: conn?.id ?? savedId.current,
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
    noStmtCache: f.noStmtCache,
    group: f.group.trim() || null,
    color: f.color || null,
    keepAliveSec: f.keepAliveSec,
    initSql: f.initSql.trim() || null,
  });

  const validate = () => {
    let field: string | null = null;
    if (!fromProp) {
      if (!raw && !f.host.trim()) field = "host";
      else if (!raw && f.port.trim() && (!/^\d+$/.test(f.port.trim()) || +f.port < 1 || +f.port > 65535)) field = "port";
      else if (!raw && !f.service.trim()) field = "service";
      else if (!f.url.trim()) field = "url";
      else if (!f.user.trim()) field = "user";
    }
    if (!field) return true;
    setView(current => ({ ...current, invalid: field }));
    document.getElementById(fieldId(field))?.focus();
    return false;
  };

  const needHome =
    !!test.err &&
    ["need-nc-home", "need-jvm"].includes(parseDbError(test.err).code) &&
    f.engine !== "rust";

  const lock=useRef(false);
  const runTest = async () => {
    if(lock.current) { if (saving) toast("正在保存配置，请稍候再测试","info"); return; }
    if (!validate()) return;
    const task=beginOperation(dbTaskSpec(`connection.test:${conn?.id || "new"}`,"测试数据库连接",conn?.id ?? null,"连接配置"));
    if(!task) return;lock.current=true;
    const version = formVersion.current;
    setTesting(true);
    setTest({ busy: true });
    try {
      const ok=await dbApi.test(input(), f.password || undefined);
      task.finish("success", "连接测试已通过");
      if (alive.current && version === formVersion.current) setTest({ ok });
    } catch (e) {
      task.finish("failed","连接测试失败，返回连接配置查看原因");
      // 存原始错误（带 `code|` 前缀）：needHome 要解析它，显示时再 friendlyDbError
      if (alive.current && version === formVersion.current) setTest({ err: e instanceof Error ? e.message : String(e) });
    } finally {lock.current=false;setTesting(false);}
  };

  const save = async (connectAfter = false) => {
    if(lock.current) { if (testing) toast("正在测试连接，请稍候再保存","info"); return; }
    if (!validate()) return;
    const task=beginOperation(dbTaskSpec(`connection.save:${conn?.id || "new"}`,"保存数据库连接配置",conn?.id ?? null,"连接配置"));
    if(!task) return;lock.current=true;setSaving(true);onSaving?.(true);
    try {
      const target = conn && (conn.url !== f.url.trim() || conn.user !== f.user.trim() || conn.engine !== input().engine || (conn.defaultSchema ?? "") !== f.defaultSchema.trim() || (conn.noStmtCache ?? false) !== f.noStmtCache);
      // 连接串、用户、引擎或「关闭语句缓存」变了：旧会话已经不是这个连接了，必须先断开。
      // 语句缓存的大小是建连接时定死的，改开关同样要重连才生效。
      //
      // 🔴 不能直接调 store 的 `disconnect`：那会绕过 `guardAllSessions`，primary 和
      // 每个槽里未提交的写入会被桥静默回滚，而界面只弹一句绿色「配置已保存」。
      // 先问、再存：用户点取消时配置也不落地，避免「配置是新的、会话还是旧的」。
      if (target && conn && rtOf(conn.id).status === "connected") {
        // 动态 import：`dbActions` 会顺着 sqlModels 把整个 Monaco 拉进来，
        // 而这只在「改地址 / 开关后保存」时用得上。静态引入会让所有渲染表单的地方都背上 Monaco。
        const { disconnectConn } = await import("../../lib/dbActions");
        const closed = await disconnectConn(conn.id);
        if (!closed) {
          task.finish("cancelled", "未断开旧会话，配置没有保存");
          return;
        }
      }
      // 连库时只在认证成功后记住密码，失败重试不会把错密码写入已保存配置。
      const saved = await dbApi.save(input(), connectAfter ? undefined : f.password || undefined, f.remember);
      savedId.current = saved.id;
      if (!connectAfter && f.password && f.remember && saved.hasPassword === false) {
        toast("密码未能保存，下次连接需要重新输入", "warning");
      }
      await loadConns();
      task.finish("success", "配置已保存");
      if (connectAfter) {
        let error = "";
        const result = await connect(saved.id, f.password || undefined, f.remember, reason => { error = reason; });
        if (result !== "ok") {
          if (alive.current) {
            setTest({ err: result === "need-password" && !f.password ? "need-password|请输入密码后重试" : error || "连接失败", saved: true });
          }
          return;
        }
      }
      if (alive.current) closeConnDialog();
    } catch (e) {
      task.finish("failed","配置保存失败，返回连接配置查看原因");
      setTest({ err: e instanceof Error ? e.message : String(e) });
    } finally {
      lock.current=false;setSaving(false);onSaving?.(false);
    }
  };

  return (
    <>
      <div className="bd dbx-conn-body" aria-busy={saving || testing}>
        <ConnTestResult test={test} needHome={needHome} onUseRust={() => put({ engine: "rust" })} />
        <fieldset className="dbx-conn-fields" disabled={saving}>
          {fromProp ? (
            <p className="dbx-conn-origin"><strong>{conn.propDs}</strong> · {f.user}<br />{f.url}</p>
          ) : (
            <>
              <ConnAddressFields form={f} fieldId={fieldId} put={put} invalid={invalid} raw={raw}
                setRaw={raw => setView(current => ({ ...current, raw, invalid: null }))} />
              <div className="dbx-conn-pair">
                <div className="dbx-conn-field">
                  <label htmlFor={fieldId("user")}>用户名</label>
                  <input id={fieldId("user")} className="dbx-inp mono" value={f.user}
                    aria-invalid={invalid === "user" || undefined}
                    aria-describedby={invalid === "user" ? fieldId("user-error") : undefined}
                    onChange={event => put({ user: event.target.value })} />
                  {invalid === "user" && <span id={fieldId("user-error")} className="dbx-conn-error">请输入用户名</span>}
                </div>
                <div className="dbx-conn-field">
                  <label htmlFor={fieldId("password")}>密码</label>
                  <input id={fieldId("password")} className="dbx-inp" type="password" value={f.password}
                    placeholder={conn?.hasPassword ? "已保存" : undefined}
                    onChange={event => put({ password: event.target.value })} />
                  <label className="dbx-chk"><input type="checkbox" checked={f.remember}
                    onChange={event => put({ remember: event.target.checked })} />记住密码</label>
                </div>
              </div>
            </>
          )}
          <div className="dbx-conn-pair">
            <div className="dbx-conn-field">
              <label htmlFor={fieldId("name")}>连接名称</label>
              <input id={fieldId("name")} className="dbx-inp" value={f.name} placeholder="选填，默认用服务名"
                onChange={event => put({ name: event.target.value })} />
            </div>
            <div className="dbx-conn-field">
              <label htmlFor={fieldId("env")}>环境</label>
              <select id={fieldId("env")} className="dbx-inp" value={f.env}
                onChange={event => put({ env: event.target.value as DbConnForm["env"] })}>
                {ENVS.map(env => <option value={env} key={env}>{ENV_LABEL[env]}</option>)}
              </select>
            </div>
          </div>
        </fieldset>
        <fieldset id={fieldId("advanced")} className="dbx-conn-advanced" hidden={!advanced} disabled={saving}>
          <h3 className="dbx-form-section">连接与事务</h3>
          <label htmlFor={fieldId("schema")}>默认 Schema</label>
          <input id={fieldId("schema")} className="dbx-inp mono" value={f.defaultSchema} placeholder="留空时使用登录账号"
            onChange={event => put({ defaultSchema: event.target.value })} />
          <span id={fieldId("engine")}>引擎</span>
          <div className="dbx-txmode" role="group" aria-labelledby={fieldId("engine")}>
            <button type="button" aria-pressed={f.engine === "rust"} data-on={f.engine === "rust" || undefined}
              onClick={() => put({ engine: "rust" })}>纯 Rust 驱动</button>
            <button type="button" aria-pressed={f.engine === "java"} data-on={f.engine === "java" || undefined}
              title={hasHome === false ? "还没配 NC 安装目录，可下载数据库 JVM 组件" : undefined}
              onClick={() => put({ engine: "java" })}>JVM 桥</button>
          </div>
          {f.engine === "java" && <p className="dbx-hint">支持 REF CURSOR，需要 Java 和 Oracle 驱动。</p>}
          {f.engine === "rust" && <ConnStmtCacheToggle checked={f.noStmtCache} onChange={noStmtCache => put({ noStmtCache })} />}
          <span id={fieldId("tx")}>事务</span>
          <div className="dbx-txmode" role="group" aria-labelledby={fieldId("tx")}>
            <button type="button" aria-pressed={!f.autoCommit} data-on={!f.autoCommit || undefined}
              onClick={() => put({ autoCommit: false })}>手动提交</button>
            <button type="button" aria-pressed={f.autoCommit} data-on={f.autoCommit || undefined}
              onClick={() => put({ autoCommit: true })}>自动提交</button>
          </div>
          {f.autoCommit && <p className="dbx-hint">每条成功的写入语句会自动提交。</p>}
          <h3 className="dbx-form-section">会话</h3>
          <ConnSessionFields id={fieldId("session")} keepAliveSec={f.keepAliveSec} initSql={f.initSql}
            onKeepAlive={keepAliveSec => put({ keepAliveSec })} onInitSql={initSql => put({ initSql })} />
          <h3 className="dbx-form-section">连接标记</h3>
          <ConnGroupColorFields id={fieldId("conn")} group={f.group} color={f.color} knownGroups={groupNames(conns)}
            onGroup={group => put({ group })} onColor={color => put({ color })} />
          <label htmlFor={fieldId("note")}>备注</label>
          <input id={fieldId("note")} className="dbx-inp" value={f.note} onChange={event => put({ note: event.target.value })} />
        </fieldset>
      </div>
      <TaskFeedback active={testing || saving} compact label={testing ? "正在测试数据库连接…" : "正在保存连接配置…"} />
      <div className="ft">
        <button type="button" className="dbx-btn ghost" aria-expanded={advanced} aria-controls={fieldId("advanced")}
          onClick={() => {
            setView(current => ({ ...current, advanced: !advanced }));
            if (!advanced) requestAnimationFrame(() => document.getElementById(fieldId("advanced"))?.scrollIntoView?.({ block: "start" }));
          }}>高级设置</button>
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn" aria-busy={testing || undefined} disabled={testing || saving} onClick={() => void runTest()}>
          {testing ? <BusyIndicator size={12} /> : <Icon name="plug" size={12} />}
          {testing ? "测试中…" : "测试连接"}
        </button>
        <button type="button" className={conn ? "dbx-btn pri" : "dbx-btn"} disabled={saving || testing} onClick={() => void save()}>
          {conn ? "保存" : "仅保存"}
        </button>
        {!conn && <button type="button" className="dbx-btn pri" disabled={saving || testing} onClick={() => void save(true)}>
          {saving ? "处理中…" : "保存并连接"}
        </button>}
      </div>
    </>
  );
}
