import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { EnvChips } from "./EnvChips";
import { friendlyDbError, parseDbError, type DbError } from "../../lib/db";
import { dbApi, type DbEnv, type PropSource } from "../../lib/dbApi";
import { beginOperation } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
import { closeConnDialog, loadConns } from "../../lib/dbStore";
import { requestSettingsSection } from "../../lib/settingsJump";

/** 从 NC prop.xml 导入：列出全部数据源（不止 isBase 那个），勾选添加。 */
export function PropImportPane() {
  const [data, setData] = useState<{ source: string; sources: PropSource[] } | null>(null);
  const [err, setErr] = useState<{ text: string; code: DbError["code"] } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [env, setEnv] = useState<DbEnv>("test");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dbApi.propSources().then(setData, (e) => setErr({ text: friendlyDbError(e), code: parseDbError(e).code }));
  }, []);

  const toggle = (name: string) =>
    setPicked((old) => (old.includes(name) ? old.filter((n) => n !== name) : [...old, name]));

  const lock=useRef(false);
  const add = async () => {
    if(lock.current) return;
    const task=beginOperation(dbTaskSpec("connection.import","导入 NC 数据源配置",null,"连接配置"));
    if(!task) return;lock.current=true;setBusy(true);
    try {
      await dbApi.propImport(picked, env);
      await loadConns();
      task.finish("success","连接配置已导入");closeConnDialog();
    } catch (e) {
      task.finish("failed","配置导入失败，返回连接配置查看原因");
      setErr({ text: friendlyDbError(e), code: parseDbError(e).code });
    } finally {
      lock.current=false;setBusy(false);
    }
  };

  const needHome = err?.code === "need-nc-home";
  /** 去设置 → 开发 →「NC 环境」配 NC home（HeaderMenus / PatchHealth 同款跳转）。 */
  const goNcEnv = () => {
    requestSettingsSection("NC 环境");
    window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "settings" }));
  };

  return (
    <>
      <div className="bd">
        <label>来源</label>
        <span className="dbx-mono dbx-muted" style={{ wordBreak: "break-all" }}>{data?.source ?? (needHome ? "未读取（需要 NC home）" : "读取中…")}</span>
        {!needHome && (
          <div className="dbx-dslist">
          <div className="r h">
            <span />
            <span>数据源</span>
            <span>连接串</span>
            <span>用户</span>
            <span>状态</span>
          </div>
          {(data?.sources ?? []).map((s) => (
            <label className="r" key={s.name} style={{ cursor: s.added ? "default" : "pointer" }}>
              <input type="checkbox" disabled={s.added} checked={s.added || picked.includes(s.name)} onChange={() => toggle(s.name)} />
              <b>
                {s.name}
                {s.isBase && <span className="dbx-cnt" style={{ marginLeft: 4 }}>base</span>}
              </b>
              <span className="mono" title={s.url}>{s.url}</span>
              <span className="mono">{s.user}</span>
              <span className="dbx-muted">{s.added ? "已添加" : s.hasPassword ? "可解密" : "无口令"}</span>
            </label>
          ))}
          {data && data.sources.length === 0 && <div className="r" style={{ display: "block", lineHeight: "32px" }}>prop.xml 里没有数据源</div>}
          </div>
        )}
        {!needHome && (
          <>
            <label>环境</label>
            <EnvChips value={env} onChange={setEnv} />
            <p className="dbx-hint">口令用 NC 自带的 PropXMLReader 现解，不用再输；prop.xml 改了自动跟着变。</p>
          </>
        )}
        {needHome ? (
          <div className="dbx-homeguide">
            <Icon name="alert" size={14} />
            <div>
              <p>这一页从 NC 安装目录的 <code>ierp/bin/prop.xml</code> 读数据源，并用 NC 自带的类解密口令——需要先配置 NC home。</p>
              <div className="dbx-homeguide-actions">
                <button type="button" className="dbx-btn pri" onClick={goNcEnv}>
                  去设置 → 开发 →「NC 环境」配置
                </button>
                <span className="dbx-muted">不配 NC home 也能连库：关闭这一页，用「手动填写」或「导入 .properties」（纯 Rust 驱动不依赖 NC home）。</span>
              </div>
            </div>
          </div>
        ) : err ? (
          <div className="dbx-badline">
            <Icon name="alert" size={13} />
            <span>{err.text}</span>
          </div>
        ) : null}
      </div>
      <div className="ft">
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn" onClick={closeConnDialog}>
          取消
        </button>
        <button type="button" className="dbx-btn pri" disabled={picked.length === 0 || busy} onClick={() => void add()}>
          添加 {picked.length || ""} 个
        </button>
      </div>
    </>
  );
}
