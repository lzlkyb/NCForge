import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { EnvChips } from "./EnvChips";
import { ConnStmtCacheToggle } from "./ConnStmtCacheToggle";
import { ConnGroupColorFields } from "./ConnGroupColorFields";
import { ConnSessionFields } from "./ConnSessionFields";
import { ConnTestResult } from "./ConnTestResult";
import { parseDbError } from "../../lib/db";
import { dbApi, type DbConn, type DbConnInput, type TestResult } from "../../lib/dbApi";
import { initialConnForm, mergeConnForm, type DbConnForm } from "../../lib/dbConnForm";
import { groupNames } from "../../lib/dbConnGroups";
import { ncHomeProbe } from "../../lib/server";
import { beginOperation } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
import { closeConnDialog, loadConns, rtOf, useDbConns } from "../../lib/dbStore";

/**
 * 手动填写（新建或编辑）。主机 / 端口 / 服务名与 JDBC URL 两种写法互相同步
 * （同步规则在 `lib/dbConnForm.ts`，可单独测）。
 *
 * 来自 prop.xml 的连接只能改名称 / 环境 / 事务模式 / 引擎：连接串与口令跟着 prop.xml 走。
 * 选纯 Rust 驱动时，口令会在第一次连接时由 JVM 桥解一次并加密存本机（之后不再需要 JVM）。
 */
export function ConnManualForm({ conn }: { conn: DbConn | null }) {
  const formId = useId();
  const fieldId = (field: string) => `${formId}-${field}`;
  const [f, setF] = useState<DbConnForm>(() => initialConnForm(conn));
  // 已有分组名，只用来给分组输入框做候选（`datalist`），不参与保存逻辑。
  const conns = useDbConns();
  const [test, setTest] = useState<{ ok?: TestResult; err?: string; busy?: boolean }>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const formVersion = useRef(0);
  useEffect(() => () => { formVersion.current++; }, []);
  const fromProp = conn?.source === "prop";
  /**
   * 这台机器有没有可用的 NC home。`null` = 还没探明。
   *
   * 只用来给 JVM 桥加标注——**不拦用户选**，也**不等于「JVM 桥不可用」**：
   * JVM 桥要的是「一套 Java + Oracle 驱动」，NC home 只是最省事的来源，
   * `ncdb` 资源包或系统 Java 也能顶上（见后端 `jvm_runtime`）。选错了还有
   * `need-nc-home` / `need-jvm` 兜底，那条路给一键换引擎。
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

  const put = (patch: Partial<DbConnForm>) => {
    formVersion.current++;
    setF((cur) => mergeConnForm(cur, patch));
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
    noStmtCache: f.noStmtCache,
    group: f.group.trim() || null,
    color: f.color || null,
    keepAliveSec: f.keepAliveSec,
    initSql: f.initSql.trim() || null,
  });

  const missing = !f.url.trim() ? "连接串" : !f.user.trim() ? "用户名" : null;
  /**
   * 后端发的「需要 NC home」码：红条据此给出「换引擎」的一键出路，不让用户对着一段说明自己想办法。
   *
   * 解析的是**原始错误**（`code|message`），不是 `friendlyDbError` 之后的文案——那一步会把
   * `code|` 前缀剥掉，再解析就只剩 `other` 了（测试 `need-nc-home 红条给出一键出路` 守这条）。
   */
  const needHome =
    !!test.err &&
    ["need-nc-home", "need-jvm"].includes(parseDbError(test.err).code) &&
    f.engine !== "rust";

  const lock=useRef(false);
  const runTest = async () => {
    if(lock.current) { if (saving) toast("正在保存配置，请稍候再测试","info"); return; }
    const task=beginOperation(dbTaskSpec(`connection.test:${conn?.id || "new"}`,"测试数据库连接",conn?.id ?? null,"连接配置"));
    if(!task) return;lock.current=true;
    const version = formVersion.current;
    setTesting(true);
    setTest({ busy: true });
    try {
      const ok=await dbApi.test(input(), f.password || undefined);
      task.finish("success","连接测试已通过");if (version === formVersion.current) setTest({ok});
    } catch (e) {
      task.finish("failed","连接测试失败，返回连接配置查看原因");
      // 存原始错误（带 `code|` 前缀）：needHome 要解析它，显示时再 friendlyDbError
      if (version === formVersion.current) setTest({ err: e instanceof Error ? e.message : String(e) });
    } finally {lock.current=false;setTesting(false);}
  };

  const save = async () => {
    if(lock.current) { if (testing) toast("正在测试连接，请稍候再保存","info"); return; }
    const task=beginOperation(dbTaskSpec(`connection.save:${conn?.id || "new"}`,"保存数据库连接配置",conn?.id ?? null,"连接配置"));
    if(!task) return;lock.current=true;setSaving(true);
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
      const saved = await dbApi.save(input(), f.password || undefined, f.remember);
      // 本机存不下口令（例如 macOS 钥匙串被拒）时后端只降级、不报错：这里必须说出来，
      // 否则用户以为「记住」生效了，下次连接却又要口令。
      if (f.password && f.remember && saved.hasPassword === false) {
        toast("口令没存到本机，下次连接需要重新输入", "warning");
      }
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
        <ConnGroupColorFields
          id={fieldId("conn")}
          group={f.group}
          color={f.color}
          knownGroups={groupNames(conns)}
          onGroup={(group) => put({ group })}
          onColor={(color) => put({ color })}
        />
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
            title={hasHome === false ? "这台机器还没配 NC 安装目录（JVM 桥也可以靠下载「数据库 JVM 组件」）" : undefined}
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
                ? "JVM 桥：能力最全（REF CURSOR、解 prop.xml 口令），需要一套 Java 运行时与 Oracle 驱动。装了 NC 就到「设置 → 开发 → NC 环境」配一下目录；没装 NC 就到「设置 → 组件」下载「数据库 JVM 组件」。两样都没有也不影响用库——选「纯 Rust 驱动」即可，只是没有 REF CURSOR。"
                : "JVM 桥：能力最全（支持 REF CURSOR、能解 prop.xml 口令），多条连接共用一个 JVM；要用 NC 自带的 Java 与驱动，先在设置里配置 NC home。"}
        </p>
        {f.engine === "rust" && (
          <ConnStmtCacheToggle checked={f.noStmtCache} onChange={noStmtCache => put({ noStmtCache })} />
        )}
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
        <h3 className="dbx-form-section">会话维持</h3>
        <ConnSessionFields
          id={fieldId("session")}
          keepAliveSec={f.keepAliveSec}
          initSql={f.initSql}
          onKeepAlive={(keepAliveSec) => put({ keepAliveSec })}
          onInitSql={(initSql) => put({ initSql })}
        />
        <label htmlFor={fieldId("note")}>备注</label>
        <input id={fieldId("note")} className="dbx-inp" value={f.note} onChange={(e) => put({ note: e.target.value })} />
        <ConnTestResult test={test} needHome={needHome} onUseRust={() => put({ engine: "rust" })} />
      </div>
      <div className="ft">
        <button type="button" className="dbx-btn" disabled={!!missing || testing || saving} onClick={() => void runTest()}>
          <Icon name={testing ? "spinner" : "plug"} size={12} />
          {testing ? "测试中…" : "测试连接"}
        </button>
        {missing && <span className="dbx-muted">还缺{missing}</span>}
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn" onClick={closeConnDialog}>
          取消
        </button>
        <button type="button" className="dbx-btn pri" disabled={!!missing || saving || testing} title={testing ? "正在测试连接，请稍候" : undefined} onClick={() => void save()}>
          {conn ? "保存" : "添加"}
        </button>
      </div>
    </>
  );
}
