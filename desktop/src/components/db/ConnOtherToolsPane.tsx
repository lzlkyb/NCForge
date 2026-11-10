import { useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { EnvChips } from "./EnvChips";
import { friendlyDbError } from "../../lib/db";
import { dbApi, type DbEnv, type ImportCandidate, type ImportScan, type ImportTool } from "../../lib/dbApi";
import { beginOperation } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
import { closeConnDialog, loadConns } from "../../lib/dbStore";
import { toast } from "../ui/toast";

const TOOL_LABEL: Record<ImportTool, string> = { datagrip: "DataGrip", plsql: "PL/SQL Developer" };

/** `dataSources.local.xml`：只有用户名、没有连接串。 */
const looksLocal = (text: string) => /<user-name[\s>]/i.test(text) && !/<jdbc-url[\s>]/i.test(text);

/** tnsnames.ora：文件名叫这个，或内容是「别名 = (DESCRIPTION …)」。 */
const looksTns = (name: string, text: string) =>
  /tnsnames\.ora$/i.test(name) || (/^\s*[A-Za-z0-9_.$#]+\s*=/m.test(text) && /\(DESCRIPTION\s*=/i.test(text));

/** 从 DataGrip / PL/SQL Developer 导入连接（只导结构，口令首次连接时再输）。 */
export function OtherToolsPane() {
  const xmlRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const prefsRef = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const [scan, setScan] = useState<ImportScan | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [env, setEnv] = useState<DbEnv>("test");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState("");

  const run = async (fn: () => Promise<ImportScan>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setErr(null);
    try {
      const next = await fn();
      setScan(next);
      setPicked([]);
    } catch (e) {
      setScan(null);
      setPicked([]);
      setErr(friendlyDbError(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  /** 一次选多个 xml：带 `<jdbc-url>` 的是 dataSources.xml，其余带 `<user-name>` 的是 local。 */
  const pickXml = async (list: FileList | null) => {
    let main: { name: string; text: string } | null = null;
    const locals: string[] = [];
    for (const f of Array.from(list ?? [])) {
      const text = await f.text();
      if (looksLocal(text)) locals.push(text);
      else if (/<jdbc-url[\s>]/i.test(text) && !main) main = { name: f.name, text };
    }
    if (!main) {
      setErr("没找到 dataSources.xml（带 <jdbc-url> 的那个文件）。只选 dataSources.local.xml 不够");
      return;
    }
    const found = main;
    await run(() => dbApi.importDataGrip(found.text, found.name, locals.join("\n") || null));
  };

  const pickZip = async (f: File | undefined) => {
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    await run(() => dbApi.importDataGripZip(bytes));
  };

  const pickPrefs = async (list: FileList | null) => {
    let prefs: { name: string; text: string } | null = null;
    let tns: { name: string; text: string } | null = null;
    for (const f of Array.from(list ?? [])) {
      const text = await f.text();
      if (looksTns(f.name, text)) {
        tns ??= { name: f.name, text };
      } else {
        prefs ??= { name: f.name, text };
      }
    }
    if (!prefs && !tns) {
      setErr("没读到 user.prefs 或 tnsnames.ora 的内容");
      return;
    }
    await run(() =>
      dbApi.importPlsql(false, prefs?.text ?? null, prefs?.name ?? null, tns?.text ?? null, tns?.name ?? null),
    );
  };

  const toggle = (key: string) =>
    setPicked((old) => (old.includes(key) ? old.filter((k) => k !== key) : [...old, key]));

  const add = async () => {
    if (lock.current || !scan) return;
    const wants = scan.items
      .filter((c) => picked.includes(c.key))
      .map((c) => ({ name: c.name, url: c.url, user: c.user, tool: c.tool }));
    if (wants.length === 0) return;
    const task = beginOperation(dbTaskSpec("connection.import", "从其他工具导入连接", null, "连接配置"));
    if (!task) return;
    lock.current = true;
    setBusy(true);
    try {
      const out = await dbApi.importApply(wants, env);
      await loadConns();
      if (out.added === 0) {
        task.finish("failed", "没有新增连接：都已在连接列表里");
        setErr(out.skipped.slice(0, 3).join("；") || "没有新增连接");
        return;
      }
      task.finish("success", `已导入 ${out.added} 个连接${out.skipped.length ? `，跳过 ${out.skipped.length} 个` : ""}`);
      // 弹窗马上关掉，跳过原因必须在这里说全：只截前 3 条等于让用户猜剩下的为什么没进来。
      if (out.skipped.length) {
        const more = out.skipped.length > 3 ? ` 等 ${out.skipped.length} 条` : "";
        toast(`已导入 ${out.added} 个，跳过 ${out.skipped.length} 个：${out.skipped.slice(0, 3).join("；")}${more}`, "warning");
      }
      closeConnDialog();
    } catch (e) {
      task.finish("failed", "配置导入失败，返回连接配置查看原因");
      setErr(friendlyDbError(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const items = scan?.items ?? [];
  const status = (c: ImportCandidate) =>
    c.duplicate ? "已添加" : (c.near ?? c.warning ?? "可导入");
  const tip = (c: ImportCandidate) => [c.origin, c.near, c.warning].filter(Boolean).join("\n");

  return (
    <>
      <div className="bd">
        <label>来源</label>
        <span className="dbx-mono dbx-muted" style={{ wordBreak: "break-all" }}>
          {scan?.source ?? "未读取"}
        </span>

        <label>DataGrip</label>
        <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="dbx-btn" disabled={busy} onClick={() => xmlRef.current?.click()}>
            <Icon name="folder" size={12} />
            选择 XML…
          </button>
          <button type="button" className="dbx-btn" disabled={busy} onClick={() => zipRef.current?.click()}>
            <Icon name="upload" size={12} />
            选择 settings.zip…
          </button>
          <span className="dbx-muted">项目里的 .idea/dataSources.xml，或导出的设置包</span>
          <input ref={xmlRef} type="file" accept=".xml" multiple hidden onChange={(e) => void pickXml(e.target.files)} />
          <input ref={zipRef} type="file" accept=".zip" hidden onChange={(e) => void pickZip(e.target.files?.[0])} />
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            className="dbx-inp"
            value={paste}
            placeholder="或粘贴 Copy Data Source 得到的 XML"
            onChange={(e) => setPaste(e.target.value)}
          />
          <button
            type="button"
            className="dbx-btn"
            disabled={busy || !paste.trim()}
            onClick={() => void run(() => dbApi.importDataGrip(paste, "粘贴的 XML", null))}
          >
            解析
          </button>
        </span>

        <label>PL/SQL Developer</label>
        <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="dbx-btn" disabled={busy} onClick={() => void run(() => dbApi.importPlsql(true, null, null, null, null))}>
            <Icon name="search" size={12} />
            扫描本机
          </button>
          <button type="button" className="dbx-btn" disabled={busy} onClick={() => prefsRef.current?.click()}>
            <Icon name="folder" size={12} />
            选择 user.prefs / tnsnames.ora…
          </button>
          <input ref={prefsRef} type="file" accept=".prefs,.ora,.txt" multiple hidden onChange={(e) => void pickPrefs(e.target.files)} />
        </span>
        <p className="dbx-hint">
          只读连接地址与用户名：两家工具都不导出可用的口令，导入后首次连接时输一次即可（可勾「记住」）。
          导入的连接默认用纯 Rust 驱动，不依赖 NC home。
        </p>

        {(scan || err) && <label>预览</label>}
        {scan && (
          <div className="dbx-dslist">
            <div className="r h">
              <span />
              <span>名称</span>
              <span>连接串</span>
              <span>用户</span>
              <span>状态</span>
            </div>
            {items.map((c) => (
              <label className="r" key={c.key} title={tip(c)} style={{ cursor: c.duplicate ? "default" : "pointer" }}>
                <input
                  type="checkbox"
                  disabled={c.duplicate}
                  checked={c.duplicate || picked.includes(c.key)}
                  onChange={() => toggle(c.key)}
                />
                <b>
                  {c.name}
                  <span className="dbx-cnt" style={{ marginLeft: 4 }}>{TOOL_LABEL[c.tool]}</span>
                </b>
                <span className="mono" title={c.url}>{c.url}</span>
                <span className="mono">{c.user || "—"}</span>
                <span
                  className="dbx-muted"
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {status(c)}
                </span>
              </label>
            ))}
            {items.length === 0 && (
              <div className="r" style={{ display: "block", lineHeight: "32px" }}>
                没有读到可导入的 Oracle 连接
              </div>
            )}
          </div>
        )}
        {(scan?.warnings ?? []).map((w, i) => (
          <p className="dbx-hint" key={`${i}-${w}`}>{w}</p>
        ))}
        {err && (
          <div className="dbx-badline">
            <Icon name="alert" size={13} />
            <span>{err}</span>
          </div>
        )}
        {items.length > 0 && (
          <>
            <label>环境</label>
            <EnvChips value={env} onChange={setEnv} />
          </>
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
