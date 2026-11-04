import { useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { EnvChips } from "./EnvChips";
import { friendlyDbError, parseDbError } from "../../lib/db";
import { dbApi, type DbEnv } from "../../lib/dbApi";
import { beginOperation } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
import { closeConnDialog, loadConns } from "../../lib/dbStore";

/** 导入 .properties（url / user / pwd，与 ncdb.sh 的 --conf 文件同格式）。 */
export function PropsFileImportPane() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [name, setName] = useState("");
  const [env, setEnv] = useState<DbEnv>("test");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    setFile({ name: f.name, text: await f.text() });
    if (!name) setName(f.name.replace(/\.properties$/i, "").replace(/^db-/, ""));
  };

  const lock=useRef(false);
  const add = async () => {
    if(lock.current) return;
    if (!file) return;
    const task=beginOperation(dbTaskSpec("connection.import","导入数据库配置文件",null,"连接配置"));
    if(!task) return;lock.current=true;setBusy(true);
    try {
      await dbApi.importProps(file.text, file.name, name.trim(), env);
      await loadConns();
      task.finish("success","连接配置已导入");closeConnDialog();
    } catch (e) {
      task.finish("failed","配置导入失败，返回连接配置查看原因");
      setErr(parseDbError(e).code === "dup" ? `已有同一个库和用户的连接：${parseDbError(e).message}` : friendlyDbError(e));
    } finally {
      lock.current=false;setBusy(false);
    }
  };

  return (
    <>
      <div className="bd">
        <label>文件</label>
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <button type="button" className="dbx-btn" onClick={() => fileRef.current?.click()}>
            <Icon name="folder" size={12} />
            选择文件…
          </button>
          <span className="dbx-mono dbx-muted">{file?.name ?? "未选择"}</span>
          <input ref={fileRef} type="file" accept=".properties,.txt,.conf" hidden onChange={(e) => void pick(e.target.files?.[0])} />
        </span>
        <p className="dbx-hint">
          读 <code>url</code> / <code>user</code>（或 username）/ <code>pwd</code>（或 password）三个键；口令用 Windows 加密存本机，原文件不动。
        </p>
        <label>名称</label>
        <input className="dbx-inp" value={name} placeholder="留空则用服务名" onChange={(e) => setName(e.target.value)} />
        <label>环境</label>
        <EnvChips value={env} onChange={setEnv} />
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
        <button type="button" className="dbx-btn pri" disabled={!file || busy} onClick={() => void add()}>
          导入
        </button>
      </div>
    </>
  );
}
