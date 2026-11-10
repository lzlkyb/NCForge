import { CodePreview } from "./CodePreview";
import { useEffect, useState } from "react";
import "../../db-console.css";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { fillParams } from "../../lib/sqlExtract";
import { loadParamValues, requestExtract, saveParamValues, useExtractRequest } from "../../lib/sqlExtractRequest";
import { ENV_LABEL } from "../../lib/dbApi";
import { explain, newConsole, runStatements } from "../../lib/dbActions";
import { ensureConnected } from "../../lib/dbConfirm";
import { defaultConnId, loadConns, useDbConns, useDbSelector } from "../../lib/dbStore";
import { copyText } from "../../lib/utils";

const TITLE = { run: "在数据库中执行此 SQL", explain: "查看执行计划", copy: "复制为纯 SQL" } as const;

/**
 * 从 Java 代码拼出来的 SQL：填参数、选连接，然后执行 / 看计划 / 复制。
 * 参数值原样插入（字符串引号本来就在 Java 字面量里），按「文件 + 参数名」记住。
 */
export function ExtractSqlDialog() {
  const req = useExtractRequest();
  const db = { loaded: useDbSelector((s) => s.loaded), conns: useDbConns() };
  const [values, setValues] = useState<Record<string, string>>({});
  const [connId, setConnId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!req) return;
    setValues(loadParamValues(req.file));
    if (!db.loaded) void loadConns();
    // 只在新请求到来时初始化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);
  useEffect(() => {
    if (req && !connId) setConnId(defaultConnId());
  }, [req, connId, db.conns]);

  if (!req) return null;
  const sql = fillParams(req.sql, req.params, values);
  const close = () => requestExtract(null);

  const go = async () => {
    if (busy) return;
    saveParamValues(req.file, values);
    if (req.mode === "copy") {
      close();
      await copyText(sql, () => toast("已复制拼好的 SQL", "success"), (e) => toast(`复制失败：${e}`, "error"));
      return;
    }
    if (!connId) return toast("先建一个数据库连接", "warning");
    // 先把连接建好再开控制台。`newConsole` 里是 fire-and-forget 的 ensureConnected，
    // 紧接着的 runStatements 撞上「正在连接」会直接放弃：冷连接下第一次点「执行」一条都不跑。
    setBusy(true);
    try {
      if (!(await ensureConnected(connId))) {
        toast("连接未建立，语句没有执行", "error");
        return;
      }
      // 新控制台可能会因为当前标签还有未写回改动而被用户取消：先拿到标签再关对话框
      const tabId = await newConsole(connId, sql);
      if (!tabId) return;
      close();
      window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "db" }));
      if (req.mode === "run") void runStatements(tabId, [{ text: sql, startLine: 1 }]);
      else void explain(tabId, sql);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal keepMountedWhenInactive open onClose={close} className="modal-surface dbx-dlg" ariaLabel={TITLE[req.mode]}>
      <div className="hd">
        <Icon name="database" size={16} />
        {TITLE[req.mode]}
        <span className="dbx-muted" style={{ fontWeight: 400, fontSize: 12 }}>
          第 {req.startLine}–{req.endLine} 行 · {req.pieces} 段字符串
        </span>
      </div>
      <div className="bd one">
        <CodePreview className="sql" text={sql} label="提取的 SQL" connId={connId ?? undefined}/>
        {req.params.length > 0 && (
          <div className="dbx-vars">
            {req.params.map((p) => (
              <label key={p.name} style={{ display: "contents" }}>
                <code title={p.expr}>:{p.name}</code>
                <input
                  className="dbx-inp mono sm"
                  value={values[p.name] ?? ""}
                  placeholder={p.expr}
                  onChange={(e) => setValues({ ...values, [p.name]: e.target.value })}
                />
              </label>
            ))}
          </div>
        )}
        {req.mode !== "copy" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
            <span className="dbx-muted">连接</span>
            <select className="dbx-inp sm" style={{ width: "auto" }} value={connId ?? ""} onChange={(e) => setConnId(e.target.value)}>
              {db.conns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}（{ENV_LABEL[c.env]} · {c.user}）
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="ft">
        <span className="dbx-muted">参数值原样插入：字符串记得带单引号</span>
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn" onClick={close}>
          取消
        </button>
        <button type="button" className="dbx-btn pri" disabled={busy} onClick={() => void go()}>
          {busy ? "连接中…" : req.mode === "run" ? "执行" : req.mode === "explain" ? "看计划" : "复制"}
        </button>
      </div>
    </Modal>
  );
}
