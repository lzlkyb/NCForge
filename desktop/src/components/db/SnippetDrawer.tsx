import { useMemo, useState, useSyncExternalStore } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { Highlight } from "./Highlight";
import {
  addSnippet,
  defaultName,
  filterSnippets,
  removeSnippet,
  snippetsSnapshot,
  subscribeSnippets,
  updateSnippet,
} from "../../lib/dbSnippets";

/**
 * SQL 片段库（B4）：常用的几句话存下来，点一下就填回编辑器。
 *
 * 作用域只有「这个连接」和「所有连接」两种。默认存成**这个连接**——同一件事在不同库上
 * 常常写法不同（schema 名、数据源不同），存成全局反而会到处冒出不合用的那条；
 * 真正通用的（比如「查当前会话」「看锁」）再手动改成全局。
 */
export function SnippetDrawer({ connId, getSql, onPick, onClose }: {
  connId: string;
  /** 取编辑器当前 SQL（存片段时用），由控制台提供。 */
  getSql: () => string;
  onPick: (sql: string) => void;
  onClose: () => void;
}) {
  const list = useSyncExternalStore(subscribeSnippets, () => snippetsSnapshot(connId));
  const [q, setQ] = useState("");
  /** 正在编辑的片段：`id === null` 表示新建。 */
  const [draft, setDraft] = useState<{ id: string | null; name: string; sql: string; global: boolean } | null>(null);
  const shown = useMemo(() => filterSnippets(list, q), [list, q]);

  const startNew = () => {
    const sql = getSql();
    if (!sql.trim()) {
      toast("编辑器里没有 SQL，先把要存的那句写上", "info");
      return;
    }
    setDraft({ id: null, name: defaultName(sql), sql, global: false });
  };

  const save = () => {
    if (!draft) return;
    if (!draft.sql.trim()) {
      toast("片段内容是空的", "info");
      return;
    }
    const scope = draft.global ? null : connId;
    if (draft.id) updateSnippet(draft.id, { name: draft.name, sql: draft.sql, connId: scope });
    else addSnippet({ name: draft.name, sql: draft.sql, connId: scope });
    setDraft(null);
  };

  return (
    <div className="dbx-drawer">
      <div className="hd">
        <Icon name="code" size={14} />
        片段
        <span className="dbx-cnt">{list.length}</span>
        <span className="dbx-sp" />
        <button type="button" className="dbx-ibtn" title="把编辑器里的 SQL 存成片段" onClick={startNew}>
          <Icon name="plus" size={13} />
        </button>
        <button type="button" className="dbx-ibtn" aria-label="关闭片段" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>

      {draft && (
        <div className="dbx-snipform">
          <input
            className="dbx-inp sm"
            value={draft.name}
            placeholder="片段名字"
            aria-label="片段名字"
            autoFocus
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <textarea
            className="dbx-inp mono"
            value={draft.sql}
            aria-label="片段内容"
            rows={4}
            onChange={(e) => setDraft({ ...draft, sql: e.target.value })}
          />
          <label className="dbx-snipform-row">
            <input
              type="checkbox"
              checked={draft.global}
              onChange={(e) => setDraft({ ...draft, global: e.target.checked })}
            />
            所有连接都能用（默认只在这个连接里出现）
          </label>
          <div className="dbx-snipform-row">
            <button type="button" className="dbx-btn" onClick={save}>
              <Icon name="check" size={12} />
              保存
            </button>
            <button type="button" className="dbx-btn ghost" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      <div className="flt">
        <input
          className="dbx-inp sm"
          value={q}
          placeholder="搜片段名或内容"
          aria-label="搜索片段"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="list">
        {shown.length === 0 && (
          <p className="dbx-tree-note" style={{ padding: 12 }}>
            {list.length
              ? "没有匹配的片段"
              : "还没有片段：在编辑器里写好 SQL，点右上角的 + 存下来"}
          </p>
        )}
        {shown.map((s) => (
          <div key={s.id} className="dbx-hitem snip">
            <button
              type="button"
              className="dbx-snipmain"
              title="单击填回编辑器"
              onClick={() => onPick(s.sql)}
            >
              <span className="m">
                <span className="dbx-hconn">{s.connId === null ? "全局" : "本连接"}</span>
                {s.name}
              </span>
              <code>
                <Highlight text={s.sql} query={q} />
              </code>
            </button>
            <span className="dbx-snipacts">
              <button
                type="button"
                className="dbx-ibtn"
                title="改名 / 改内容"
                onClick={() =>
                  setDraft({ id: s.id, name: s.name, sql: s.sql, global: s.connId === null })
                }
              >
                <Icon name="edit" size={12} />
              </button>
              <button
                type="button"
                className="dbx-ibtn"
                title="删除这个片段"
                onClick={() => removeSnippet(s.id)}
              >
                <Icon name="trash" size={12} />
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
