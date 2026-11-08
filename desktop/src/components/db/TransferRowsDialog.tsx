import "../../db-console.css";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { connOf, useConnRt } from "../../lib/dbStore";
import { planNote } from "../../lib/transferPlan";
import { useTransferRows } from "../../hooks/useTransferRows";
import { ConnPicker } from "./ConnPicker";
import { TransferPlanView } from "./TransferPlanView";

/**
 * 表 → 表 直连搬运（不落文件中转）的界面壳。
 *
 * 三段式：选目标 → 看映射（只读，明确列出不搬的列）→ 搬。
 * **映射必须先生成再搬**：两侧列不一样时最危险的不是报错，而是「少搬了一列却成功了」。
 * 状态机全在 `useTransferRows`，这里只负责把状态画出来。
 */
export function TransferRowsDialog({ connId, table, tabId, onClose }: {
  connId: string;
  table: string;
  tabId?: string;
  onClose: () => void;
}) {
  const left = useConnRt(connId);
  const leftOwner = (left.currentSchema ?? left.info?.schema ?? "").toUpperCase();
  const { form, run, ready, blocker, patch, pick, loadPlan, start, stop } =
    useTransferRows({ connId, table, tabId, leftOwner });
  const { rightConn, owner, other, plan, mode, filter } = form;
  const { busy, out, err } = run;

  return (
    <Modal open onClose={() => !busy && onClose()} closeOnOverlay={!busy} className="modal-surface dbx-dlg wide" ariaLabel={`把 ${table} 的数据搬到另一张表`}>
      <div className="hd">
        <Icon name="arrowRight" size={16} />
        搬运表数据
        <span className="dbx-muted" style={{ fontWeight: 400, fontSize: 12 }}>
          {table.toUpperCase()} → 另一个库的表（不落文件）
        </span>
      </div>
      <div className="bd one">
        <div className="dbx-diff-sides">
          <div className="dbx-diff-side">
            <span className="dbx-diff-side-label">源</span>
            <span className="dbx-mono">{leftOwner ? `${leftOwner}.${table.toUpperCase()}` : "…"}</span>
          </div>
          <div className="dbx-diff-side">
            <span className="dbx-diff-side-label">目标</span>
            <ConnPicker connId={rightConn} onPick={pick} disabled={!!busy} compact />
            <input
              className="dbx-inp mono"
              style={{ width: 120 }}
              value={owner}
              placeholder="schema"
              aria-label="目标 schema"
              disabled={!!busy}
              onChange={(e) => patch({ owner: e.target.value.toUpperCase(), plan: null })}
            />
            <input
              className="dbx-inp mono"
              style={{ width: 180 }}
              value={other}
              placeholder="表名"
              aria-label="目标表名"
              disabled={!!busy}
              onChange={(e) => patch({ other: e.target.value.toUpperCase(), plan: null })}
              onKeyDown={(e) => e.key === "Enter" && void loadPlan()}
            />
            <button type="button" className="dbx-btn ghost" disabled={!!busy || !leftOwner || !owner || !other} onClick={() => void loadPlan()}>
              看列映射
            </button>
          </div>
        </div>

        <div className="dbx-diff-sides" style={{ marginTop: 8 }}>
          <label className="dbx-diff-side">
            <input type="radio" checked={mode === "append"} disabled={!!busy} onChange={() => patch({ mode: "append" })} />
            追加
          </label>
          <label className="dbx-diff-side">
            <input type="radio" checked={mode === "replace"} disabled={!!busy} onChange={() => patch({ mode: "replace" })} />
            先清空目标表
          </label>
          <input
            className="dbx-inp mono"
            style={{ flex: 1, minWidth: 200 }}
            value={filter}
            placeholder="源表过滤条件（可选），如 code like 'A%'"
            aria-label="源表过滤条件"
            disabled={!!busy}
            onChange={(e) => patch({ filter: e.target.value })}
          />
        </div>

        {mode === "replace" && (
          <div className="dbx-diff-note" data-tone="warn">
            <Icon name="alertTriangle" size={12} />
            先清空目标表：清空与第一批插入在同一个事务里提交；中途失败时已提交的批会留下，目标表不会是原样。
          </div>
        )}
        {!leftOwner && <div className="dbx-hint">源连接还没读到当前 schema，先连上再来搬。</div>}
        {plan && (
          <>
            <div className="dbx-hint">{planNote(plan)}</div>
            <TransferPlanView plan={plan} />
          </>
        )}
        {blocker && plan && (
          <div className="dbx-err" style={{ marginTop: 8 }}>{blocker}</div>
        )}
        {err && <div className="dbx-err" style={{ marginTop: 8 }}>{err}</div>}
        {busy && (
          <div className="dbx-hint" style={{ marginTop: 8 }}>
            {busy.canceling ? "已请求停止，当前批写完就停…" : `已写入 ${busy.rows} 行…（每 200 行提交一次）`}
          </div>
        )}
        {out && (
          <div className="dbx-hint" style={{ marginTop: 8 }}>
            {out.canceled ? "已停止 · 已写入 " : "写进 "}
            <b>{out.copied}</b> 行 · {out.batches} 批 · {(out.ms / 1000).toFixed(1)}s
            {out.cleared && " · 目标表已先清空"}
          </div>
        )}
      </div>
      <div className="ft">
        <span className="dbx-muted">
          {plan ? `${plan.pairs.length} 列` : "先看列映射"}
          {connOf(rightConn)?.name ? ` · 目标 ${connOf(rightConn)?.name}` : ""}
        </span>
        <span className="dbx-sp" />
        {busy ? (
          <button type="button" className="dbx-btn ghost" disabled={busy.canceling} onClick={stop}>
            {busy.canceling ? "停止中…" : "停止"}
          </button>
        ) : (
          <button type="button" className="dbx-btn ghost" onClick={onClose}>关闭</button>
        )}
        <button type="button" className="dbx-btn" disabled={!ready} onClick={() => void start()}>
          <Icon name={busy ? "spinner" : "arrowRight"} size={12} />
          {busy ? "搬运中…" : out ? "再搬一次" : "开始搬运"}
        </button>
      </div>
    </Modal>
  );
}
