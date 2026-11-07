import "../../db-console.css";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { copyText } from "../../lib/utils";
import { connOf, openTableTab } from "../../lib/dbStore";
import { ENV_LABEL, type ValueHit } from "../../lib/dbApi";
import { MAX_HITS, useValueSearchRun, type MatchValue } from "../../lib/valueSearchRun";

const MODES: { v: MatchValue; label: string }[] = [
  { v: 0, label: "包含" },
  { v: 1, label: "等于" },
  { v: 2, label: "开头是" },
  { v: 3, label: "结尾是" },
];

/**
 * 全库按值反查：拿一段文本，在「当前账号所有表的所有文本列」里找它。
 *
 * 纯只读（后端只发 SELECT）。搜索走独立会话，不占用控制台的游标；扫全库可能要几分钟，
 * 所以进度、取消、命中上限三件事都必须有：一个没有任何反馈的全库扫描等于界面卡死。
 */
export function ValueSearchDialog({ connId, onClose,tabId }: { connId: string; tabId?:string; onClose: () => void }) {
  const conn = connOf(connId);
  const { form, patchForm, run, start, stop, cancelIfRunning } = useValueSearchRun(connId,tabId);

  /** 关窗 = 真的停下：否则关掉的只是界面，数据库还在全表扫。 */
  const close = () => {
    cancelIfRunning();
    onClose();
  };

  const copyHit = (h: ValueHit) =>
    void copyText(
      h.sql,
      () => toast("已复制 SQL", "success"),
      (e) => toast(`复制失败：${String(e)}`, "error"),
    );

  const copyAll = (hits: ValueHit[]) =>
    void copyText(
      hits.map((h) => `${h.sql};`).join("\n"),
      () => toast(`已复制 ${hits.length} 条 SQL`, "success"),
      (e) => toast(`复制失败：${String(e)}`, "error"),
    );

  const prog = run.phase === "running" ? run : null;
  const out = run.phase === "done" ? run.out : null;
  const pct = prog && prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : 0;

  return (
    <Modal keepMountedWhenInactive open onClose={close} className="modal-surface dbx-dlg wide dbx-vs" ariaLabel="全库按值反查">
      <div className="hd">
        <Icon name="search" size={16} />
        全库按值反查
        <span className="dbx-muted" style={{ fontWeight: 400, fontSize: 12 }}>
          {conn?.name ?? "连接"} · {conn?.user ?? ""} · {conn ? ENV_LABEL[conn.env] : ""}
        </span>
      </div>

      <div className="bd one">
        <div className="dbx-vs-form">
          <label htmlFor="vs-text" className="dbx-muted">
            要查的值
          </label>
          <textarea
            id="vs-text"
            className="dbx-inp mono dbx-vs-text"
            value={form.text}
            placeholder="例如：A001、张三、某段物料编码"
            spellCheck={false}
            autoFocus
            onChange={(e) => patchForm({ text: e.target.value })}
          />
          <div className="dbx-vs-row">
            <select
              className="dbx-inp"
              aria-label="匹配方式"
              value={form.mode}
              onChange={(e) => patchForm({ mode: Number(e.target.value) as MatchValue })}
            >
              {MODES.map((m) => (
                <option key={m.v} value={m.v}>
                  {m.label}
                </option>
              ))}
            </select>
            <input
              className="dbx-inp"
              aria-label="表名筛选"
              value={form.filter}
              placeholder="只看表名包含…（留空 = 全库）"
              spellCheck={false}
              onChange={(e) => patchForm({ filter: e.target.value })}
            />
          </div>
          <p className="dbx-vs-note dbx-muted">
            只查 <b>当前账号的表</b>（不含视图与回收站），只搜 CHAR / VARCHAR2 / NCHAR / NVARCHAR2 / CLOB / NCLOB
            列；<b>只读</b>，不会改任何数据。大库要几分钟，可随时取消。
          </p>
        </div>

        {prog && (
          <div className="dbx-vs-prog" role="status">
            <div className="dbx-vs-progtext">
              <Icon name="spinner" size={12} />
              <span>
                {prog.label}
                {prog.total > 0 ? `（${prog.done}/${prog.total} 张表）` : ""}
              </span>
              <span className="dbx-sp" />
              <span className="dbx-muted">
                命中 {prog.hits} 处{prog.errors > 0 ? ` · ${prog.errors} 张表出错` : ""}
              </span>
              <button type="button" className="dbx-btn bad" disabled={prog.cancelling} onClick={stop}>
                <Icon name="stop" size={12} />
                {prog.cancelling ? "正在请求停止…" : "取消"}
              </button>
            </div>
            <div className="dbx-vs-bar" aria-hidden>
              <i style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        {run.phase === "error" && (
          <div className="dbx-vs-alert" data-tone="bad">
            <Icon name="alertTriangle" size={14} />
            <span>{run.message}</span>
          </div>
        )}

        {out && (
          <div className="dbx-vs-result">
            <div className="dbx-vs-sum">
              <b>{out.hits.length}</b> 处命中 · 扫了 {out.tablesScanned}/{out.tablesTotal} 张表 ·{" "}
              {out.ms} ms
              {out.hits.length > 0 && (
                <button type="button" className="dbx-btn ghost" onClick={() => copyAll(out.hits)}>
                  <Icon name="copy" size={12} />
                  复制全部 SQL
                </button>
              )}
            </div>
            {out.canceled && (
              <p className="dbx-vs-alert" data-tone="warn">
                已取消：结果只覆盖已扫过的 {out.tablesScanned} 张表
              </p>
            )}
            {out.truncated && (
              <p className="dbx-vs-alert" data-tone="warn">
                命中达到上限 {MAX_HITS} 处，后面的表没有再看——请用表名筛选缩小范围
              </p>
            )}
            {out.sharedSession && (
              <p className="dbx-vs-alert" data-tone="warn">
                没能开独立会话（口令未记住），本次复用了控制台会话：控制台的「加载更多」会失效
              </p>
            )}
            {(out.skippedTables > 0 || out.skippedColumns > 0) && (
              <p className="dbx-vs-note dbx-muted">
                跳过 {out.skippedTables} 张表 / {out.skippedColumns} 个列（名字含特殊字符或类型不支持搜索）
              </p>
            )}
            {out.hits.length === 0 ? (
              <p className="dbx-vs-empty dbx-muted">
                没有命中。值可能只在视图里、在 BLOB 里，或确实不存在。
              </p>
            ) : (
              <div className="dbx-vs-list">
                <table className="dbx-vs-table">
                  <thead>
                    <tr>
                      <th>表</th>
                      <th>列</th>
                      <th>样本值</th>
                      <th aria-label="操作" />
                    </tr>
                  </thead>
                  <tbody>
                    {out.hits.map((h) => (
                      <tr key={`${h.table}.${h.column}`}>
                        <td>
                          <button
                            type="button"
                            className="dbx-vs-link"
                            title="打开这张表"
                            onClick={() => {
                              openTableTab(connId, h.table, "data");
                              close();
                            }}
                          >
                            {h.table}
                          </button>
                        </td>
                        <td className="dbx-mono">{h.column}</td>
                        <td className="dbx-mono dbx-vs-sample">{h.sample}</td>
                        <td>
                          <button
                            type="button"
                            className="dbx-ibtn"
                            title="复制这条命中对应的 SQL"
                            onClick={() => copyHit(h)}
                          >
                            <Icon name="copy" size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {out.errors.length > 0 && (
              <details className="dbx-vs-errors">
                <summary>有 {out.errors.length} 张表读不了（点开看）</summary>
                <ul>
                  {out.errors.map((e) => (
                    <li key={e} className="dbx-mono">
                      {e}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>

      <div className="ft">
        <span className="dbx-muted">只读查询 · 不影响数据</span>
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn" onClick={close}>
          关闭
        </button>
        <button type="button" className="dbx-btn pri" disabled={prog !== null} onClick={() => void start()}>
          <Icon name="search" size={12} />
          {prog ? "搜索中…" : "开始搜索"}
        </button>
      </div>
    </Modal>
  );
}
