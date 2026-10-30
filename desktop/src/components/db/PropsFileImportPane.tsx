import { useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { EnvChips } from "./EnvChips";
import { friendlyDbError, parseDbError } from "../../lib/db";
import { dbApi, type DbEnv } from "../../lib/dbApi";
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

  const add = async () => {
    if (!file) return;
    setBusy(true);
    try {
      await dbApi.importProps(file.text, file.name, name.trim(), env);
      await loadConns();
      closeConnDialog();
    } catch (e) {
      setErr(parseDbError(e).code === "dup" ? `已有同一个库和用户的连接：${parseDbError(e).message}` : friendlyDbError(e));
    } finally {
      setBusy(false);
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
