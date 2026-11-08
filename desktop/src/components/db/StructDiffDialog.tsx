import { useState } from "react";
import "../../db-console.css";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { friendlyDbError } from "../../lib/db";
import { dbApi } from "../../lib/dbApi";
import type { StructDiff } from "../../lib/dbStructDiff";
import { rtOf, useConnRt } from "../../lib/dbStore";
import { beginOperation } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
import { ConnPicker } from "./ConnPicker";
import { StructDiffResult } from "./StructDiffResult";

/**
 * 表结构对比（DDL diff）。
 *
 * 左侧固定是「这张表」（用户是从表页打开的，基准就是他正在看的那个环境的表），
 * 右侧自由选连接 + schema + 表名——跨环境核对结构就是这个动作。
 *
 * 生成脚本但**不执行**：脚本在结果区列出来由人自己挑着跑。真正的风险不在比，
 * 而在「一键把生产表改成开发表」，那一步不该由界面代劳。
 */
export function StructDiffDialog({ connId, table, tabId, onClose }: {
  connId: string;
  table: string;
  tabId?: string;
  onClose: () => void;
}) {
  const left = useConnRt(connId);
  const [rightConn, setRightConn] = useState(connId);
  const [owner, setOwner] = useState("");
  const [other, setOther] = useState(table);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<StructDiff | null>(null);

  const leftOwner = (left.currentSchema ?? left.info?.schema ?? "").toUpperCase();
  const canRun = !!leftOwner && !!owner.trim() && !!other.trim() && !busy;

  /** 换连接时把 schema 填成对方的当前 schema：手打 schema 名最容易打错。 */
  const pick = (id: string) => {
    const rt = rtOf(id);
    setRightConn(id);
    setOwner((rt.currentSchema ?? rt.info?.schema ?? "").toUpperCase());
    setRes(null);
    setErr(null);
  };

  const run = async () => {
    if (!canRun) return;
    const task = beginOperation(
      dbTaskSpec(`struct-diff:${connId}:${table}`, "对比表结构", connId, table, undefined, tabId),
    );
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      const out = await dbApi.structDiff(
        { id: connId, owner: leftOwner, table },
        { id: rightConn, owner: owner.trim(), table: other.trim() },
      );
      setRes(out);
      task?.finish(
        "success",
        out.ddl.length === 0 ? "结构一致" : `发现 ${out.ddl.length} 处需要调整（未执行任何 DDL）`,
      );
    } catch (e) {
      setErr(friendlyDbError(e));
      task?.finish("failed", "结构对比失败，返回对比窗口查看原因");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={() => !busy && onClose()} closeOnOverlay={!busy} className="modal-surface dbx-dlg wide" ariaLabel={`对比 ${table} 的表结构`}>
      <div className="hd">
        <Icon name="columns" size={16} />
        表结构对比
        <span className="dbx-muted" style={{ fontWeight: 400, fontSize: 12 }}>左侧是当前表，右侧改成左侧的样子</span>
      </div>
      <div className="bd one">
        <div className="dbx-diff-sides">
          <div className="dbx-diff-side">
            <span className="dbx-diff-side-label">左（基准）</span>
            <span className="dbx-mono">{leftOwner ? `${leftOwner}.${table.toUpperCase()}` : "…"}</span>
          </div>
          <div className="dbx-diff-side">
            <span className="dbx-diff-side-label">右（要改成左边）</span>
            <ConnPicker connId={rightConn} onPick={pick} disabled={busy} compact />
            <input
              className="dbx-inp mono"
              style={{ width: 120 }}
              value={owner}
              placeholder="schema"
              aria-label="右侧 schema"
              disabled={busy}
              onChange={(e) => setOwner(e.target.value.toUpperCase())}
            />
            <input
              className="dbx-inp mono"
              style={{ width: 200 }}
              value={other}
              placeholder="表名"
              aria-label="右侧表名"
              disabled={busy}
              onChange={(e) => setOther(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && void run()}
            />
          </div>
        </div>
        {!leftOwner && <div className="dbx-hint">左侧连接还没读到当前 schema，先连上（或先切一次 schema）再来对比。</div>}
        {err && <div className="dbx-err" style={{ marginTop: 8 }}>{err}</div>}
        {busy && <div className="dbx-hint" style={{ marginTop: 8 }}>正在读两侧数据字典…</div>}
        {res && <StructDiffResult diff={res} />}
      </div>
      <div className="ft">
        <span className="dbx-muted">
          {res ? (res.ddl.length === 0 ? "结构一致" : `${res.ddl.length} 条待执行语句 · 不会自动执行`) : "读的是数据字典，不改任何东西"}
        </span>
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn ghost" disabled={busy} onClick={onClose}>关闭</button>
        <button type="button" className="dbx-btn" disabled={!canRun} onClick={() => void run()}>
          <Icon name={busy ? "spinner" : "columns"} size={12} />
          {busy ? "对比中…" : res ? "重新对比" : "开始对比"}
        </button>
      </div>
    </Modal>
  );
}
