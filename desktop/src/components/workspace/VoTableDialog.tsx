import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { closeVoTableDialog, useVoTableRequest, voTables, type VoTableOut } from "../../lib/voTables";
import { friendlyDbError } from "../../lib/db";

/**
 * 「这个 VO 对应哪张表、哪些字段」——B3 的展示面。
 *
 * 结果直接给字段栅格（字段 / 中文名 / 类型 / 实体属性），因为用户问这句话的目的
 * 几乎总是「我要改的字段叫什么」。表名可点：点了去工程里按表名搜（改 SQL 的入口）。
 */
export function VoTableDialog({ onSearch }: { onSearch?: (text: string) => void }) {
  const className = useVoTableRequest();
  const [state, setState] = useState<{ loading: boolean; out: VoTableOut | null; error: string | null }>({
    loading: false,
    out: null,
    error: null,
  });

  useEffect(() => {
    if (!className) return;
    let live = true;
    setState({ loading: true, out: null, error: null });
    void voTables(className).then(
      (out) => { if (live) setState({ loading: false, out, error: null }); },
      (e) => { if (live) setState({ loading: false, out: null, error: friendlyDbError(e) }); },
    );
    return () => { live = false; };
  }, [className]);

  if (!className) return null;
  const out = state.out;
  const columnCount = out ? out.tables.reduce((n, t) => n + t.columns.length, 0) : 0;

  return (
    <Modal open onClose={closeVoTableDialog} className="modal-surface dbx-relations-dialog" ariaLabel="VO 对应的表与字段">
      <h2>VO 对应的表与字段</h2>
      <p>
        {className}
        {out?.voNames.length ? ` · ${out.voNames.join(" / ")}` : ""}
        {out ? ` · ${out.tables.length} 张表、${columnCount} 个字段 · ${out.elapsedMs} ms` : ""}
      </p>

      {state.loading && <p role="status">正在按 md_ormap 反查…</p>}
      {state.error && <p className="dbx-err" role="alert">{state.error}</p>}

      {out?.tables.map((t) => (
        <div key={t.name} className="dbx-meta">
          <h3>
            {t.name}
            {t.displayName ? ` · ${t.displayName}` : ""}
            {onSearch && (
              <button type="button" className="dbx-btn" onClick={() => onSearch(t.name)}>在工程中搜索</button>
            )}
          </h3>
          {t.columns.length === 0 ? (
            <p>这张表没有查到列（md_column 里没有记录）。</p>
          ) : (
            <table>
              <thead>
                <tr><th>字段</th><th>中文名</th><th>NC 类型描述</th><th>实体属性</th></tr>
              </thead>
              <tbody>
                {t.columns.map((c) => (
                  <tr key={c.name}>
                    <td>{c.name}</td>
                    <td>{c.displayName}</td>
                    <td>{c.type}</td>
                    <td>{c.props.map((p) => `${p.name} ${p.displayName}`).join(" · ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}

      {out && out.tables.length === 0 && !state.error && (
        <p>没有查到表。原因见下方说明——最常见的是元数据未发布，而不是类名写错。</p>
      )}

      {out && out.notes.length > 0 && (
        <details open>
          <summary>为什么是这些结果</summary>
          {out.notes.map((n) => <p key={n}>{n}</p>)}
          <p>数据源：{out.source}</p>
        </details>
      )}

      <div className="dbx-filter-actions">
        <button type="button" className="dbx-btn" onClick={closeVoTableDialog}>关闭</button>
      </div>
    </Modal>
  );
}
