import { useEffect, useState } from "react";
import { Icon } from "../ui/icon";
import { EnvChips } from "./EnvChips";
import { friendlyDbError } from "../../lib/db";
import { dbApi, type DbEnv, type PropSource } from "../../lib/dbApi";
import { closeConnDialog, loadConns } from "../../lib/dbStore";

/** 从 NC prop.xml 导入：列出全部数据源（不止 isBase 那个），勾选添加。 */
export function PropImportPane() {
  const [data, setData] = useState<{ source: string; sources: PropSource[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [env, setEnv] = useState<DbEnv>("test");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dbApi.propSources().then(setData, (e) => setErr(friendlyDbError(e)));
  }, []);

  const toggle = (name: string) =>
    setPicked((old) => (old.includes(name) ? old.filter((n) => n !== name) : [...old, name]));

  const add = async () => {
    setBusy(true);
    try {
      await dbApi.propImport(picked, env);
      await loadConns();
      closeConnDialog();
    } catch (e) {
      setErr(friendlyDbError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="bd">
        <label>来源</label>
        <span className="dbx-mono dbx-muted" style={{ wordBreak: "break-all" }}>{data?.source ?? "读取中…"}</span>
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
        <label>环境</label>
        <EnvChips value={env} onChange={setEnv} />
        <p className="dbx-hint">口令用 NC 自带的 PropXMLReader 现解，不用再输；prop.xml 改了自动跟着变。</p>
        {err && (
          <div className="dbx-badline">
            <Icon name="alert" size={13} />
            <span>{err}</span>
          </div>
        )}
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
