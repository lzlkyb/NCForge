import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { EnvChips } from "./EnvChips";
import { friendlyDbError } from "../../lib/db";
import { dbApi, type DbEnv, type ImportCandidate, type ImportScan, type ImportTool } from "../../lib/dbApi";
import { beginOperation } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
import { closeConnDialog, loadConns } from "../../lib/dbStore";
import { toast } from "../ui/toast";
import "./conn-other-tools.css";

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
  /**
   * 上一次导入被跳过的那几条（原因来自后端）。
   *
   * 弹窗在有跳过时会留在原地：只报前三条、又马上关窗，等于让用户猜剩下的为什么没进来。
   */
  const [skipped, setSkipped] = useState<string[]>([]);

  const run = useCallback(async (fn: () => Promise<ImportScan>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setErr(null);
    setSkipped([]);
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
  }, []);

  const scanLocal = useCallback(() => run(async () => {
    const results = await Promise.allSettled([
      dbApi.scanDataGrip(), dbApi.importPlsql(true, null, null, null, null),
    ]);
    const merged: ImportScan = { source: "本机 DataGrip / PL/SQL Developer", items: [], warnings: [] };
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        merged.items.push(...result.value.items);
        merged.warnings.push(...result.value.warnings);
      } else if (result.status === "rejected") merged.warnings.push(friendlyDbError(result.reason));
    }
    return merged;
  }), [run]);
  // 打开面板即扫一次本机配置；run 内部用 lock 防重入，这里不随依赖反复重跑。
  useEffect(() => { void scanLocal(); }, [scanLocal]);

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
      setSkipped(out.skipped);
      if (out.added === 0) {
        task.finish("failed", "没有新增连接：都已在连接列表里");
        setErr(out.skipped.length ? `没有新增连接：选中的 ${out.skipped.length} 个都被跳过，原因见下方「跳过明细」` : "没有新增连接");
        return;
      }
      task.finish("success", `已导入 ${out.added} 个连接${out.skipped.length ? `，跳过 ${out.skipped.length} 个` : ""}`);
      // 一条都没跳过才关窗；有跳过就留在面板上逐条列原因，让用户看着处理。
      if (out.skipped.length === 0) {
        closeConnDialog();
        return;
      }
      toast(`已导入 ${out.added} 个，跳过 ${out.skipped.length} 个：原因见「跳过明细」`, "warning");
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

  const available = items.filter((c) => !c.duplicate);
  const allPicked = available.length > 0 && available.every((c) => picked.includes(c.key));

  return (
    <>
      <div className="bd dbx-other-tools" aria-busy={busy}>
        <section className="dbx-import-discovery" aria-labelledby="import-discovery-title">
          <div className="dbx-import-heading">
            <span className="dbx-import-symbol"><Icon name="database" size={20} /></span>
            <div>
              <h2 id="import-discovery-title">发现本机数据库连接</h2>
              <p>自动读取 DataGrip 与 PL/SQL Developer 的连接配置</p>
            </div>
            <button type="button" className="dbx-btn" disabled={busy} onClick={() => void scanLocal()}>
              <Icon name="search" size={14} />{busy ? "正在读取…" : "重新扫描"}
            </button>
          </div>
          <div className="dbx-import-source" title={scan?.source}>
            <span>{busy ? "读取中" : "读取来源"}</span>
            <span>{scan?.source ?? "正在检查本机常见配置目录…"}</span>
          </div>
        </section>

        <details className="dbx-import-manual">
          <summary>补充导入 <span>未找到连接？选择配置文件或粘贴 XML</span></summary>
          <div className="dbx-import-tool">
            <div><h3>DataGrip</h3><p>选择项目 .idea 目录内的 XML，或导出的设置包</p></div>
            <div className="dbx-import-actions">
              <button type="button" className="dbx-btn" disabled={busy} onClick={() => xmlRef.current?.click()}><Icon name="folder" size={13} />选择 XML…</button>
              <button type="button" className="dbx-btn" disabled={busy} onClick={() => zipRef.current?.click()}><Icon name="upload" size={13} />选择 settings.zip…</button>
            </div>
            <div className="dbx-import-paste">
              <input className="dbx-inp" aria-label="DataGrip 连接 XML" value={paste} placeholder="粘贴 Copy Data Source 得到的 XML" onChange={(e) => setPaste(e.target.value)} />
              <button type="button" className="dbx-btn" disabled={busy || !paste.trim()} onClick={() => void run(() => dbApi.importDataGrip(paste, "粘贴的 XML", null))}>解析</button>
            </div>
          </div>
          <div className="dbx-import-tool">
            <div><h3>PL/SQL Developer</h3><p>支持 user.prefs 与 tnsnames.ora 配置文件</p></div>
            <div className="dbx-import-actions">
              <button type="button" className="dbx-btn" disabled={busy} onClick={() => void run(() => dbApi.importPlsql(true, null, null, null, null))}><Icon name="search" size={13} />扫描本机</button>
              <button type="button" className="dbx-btn" disabled={busy} onClick={() => prefsRef.current?.click()}><Icon name="folder" size={13} />选择配置文件…</button>
            </div>
          </div>
        </details>
        <input ref={xmlRef} type="file" accept=".xml" multiple hidden onChange={(e) => void pickXml(e.target.files)} />
        <input ref={zipRef} type="file" accept=".zip" hidden onChange={(e) => void pickZip(e.target.files?.[0])} />
        <input ref={prefsRef} type="file" accept=".prefs,.ora,.txt" multiple hidden onChange={(e) => void pickPrefs(e.target.files)} />

        {err && <div className="dbx-badline" role="alert"><Icon name="alert" size={14} /><span>{err}</span></div>}
        {skipped.length > 0 && (
          <section className="dbx-import-skipped" role="status" aria-labelledby="import-skipped-title">
            <div className="dbx-import-section-heading">
              <h3 id="import-skipped-title">跳过明细 <span>{skipped.length}</span></h3>
              <button type="button" className="dbx-btn" onClick={() => setSkipped([])}>知道了</button>
            </div>
            <ol>{skipped.map((why, i) => <li key={`${i}:${why}`}>{why}</li>)}</ol>
          </section>
        )}
        {scan && (
          <section className="dbx-import-preview" aria-labelledby="import-preview-title">
            <div className="dbx-import-section-heading">
              <h3 id="import-preview-title">连接预览 <span>{items.length}</span></h3>
              {available.length > 0 && <button type="button" className="dbx-btn" disabled={busy} onClick={() => setPicked(allPicked ? [] : available.map((c) => c.key))}>{allPicked ? "取消全选" : "全选可导入"}</button>}
            </div>
            {items.length > 0 ? <div className="dbx-dslist dbx-import-table">
              <table>
                <thead><tr><th aria-label="选择" /><th>连接名称 / 来源</th><th>连接地址 / 用户</th><th>状态</th></tr></thead>
                <tbody>{items.map((c) => (
                  <tr key={c.key} data-selected={picked.includes(c.key) || undefined} data-duplicate={c.duplicate || undefined} title={tip(c)}>
                    <td><input id={`import-${c.key}`} type="checkbox" aria-label={`选择 ${c.name}`} disabled={c.duplicate || busy} checked={c.duplicate || picked.includes(c.key)} onChange={() => toggle(c.key)} /></td>
                    <td><label htmlFor={`import-${c.key}`}><strong>{c.name}</strong></label><small>{TOOL_LABEL[c.tool]}</small></td>
                    <td><span className="dbx-import-url" title={c.url}>{c.url}</span><small>用户 · {c.user || "待补充"}</small></td>
                    <td><span className="dbx-import-status" data-ready={!c.duplicate && !c.warning && !c.near || undefined}>{status(c)}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div> : <div className="dbx-import-empty" role="status">
              <Icon name="search" size={24} />
              <strong>没有读到可导入的 Oracle 连接</strong>
              <p>可重新扫描，或展开“补充导入”选择配置文件。</p>
            </div>}
          </section>
        )}
        {(scan?.warnings.length ?? 0) > 0 && <details className="dbx-import-notes"><summary>读取说明 · {scan!.warnings.length} 条</summary><ul>{scan!.warnings.map((w, i) => <li key={`${i}-${w}`}>{w}</li>)}</ul></details>}
        {items.length > 0 && <div className="dbx-import-env"><span>导入到环境</span><EnvChips value={env} onChange={setEnv} /></div>}
        <p className="dbx-import-footnote">仅导入连接地址与用户名。首次连接时输入口令，可勾选“记住”。</p>
      </div>
      <div className="ft dbx-import-footer">
        <span className="dbx-import-selection" role="status">已选 <b>{picked.length}</b> 个连接</span>
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn" onClick={closeConnDialog}>取消</button>
        <button type="button" className="dbx-btn pri" disabled={picked.length === 0 || busy} onClick={() => void add()}>添加 {picked.length} 个连接</button>
      </div>
    </>
  );
}
