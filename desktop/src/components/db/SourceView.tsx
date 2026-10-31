import { useEffect, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { friendlyDbError } from "../../lib/db";
import { dbApi, type SourceLine } from "../../lib/dbApi";
import type { TableTab } from "../../lib/dbStore";

/**
 * 库内源码（只读）：包规范与包体各一段，按 `user_source.type` 分成两组。
 *
 * 为什么不做编辑/编译：库里改包要走 `create or replace`，一旦拼错就是把生产包改坏；
 * 而二开代码的真源在工程里（SVN）。这里只回答「这段逻辑在库里还是 Java 里」。
 */
export function SourceView({ tab }: { tab: TableTab }) {
  const [lines, setLines] = useState<SourceLine[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLines(null);
    setErr(null);
    dbApi.source(tab.connId, tab.table).then(
      (r) => setLines(r.lines),
      (e) => setErr(friendlyDbError(e)),
    );
  }, [tab.connId, tab.table]);

  if (err) return <div className="dbx-err">{err}</div>;
  if (!lines) return <div className="dbx-empty"><Icon name="spinner" size={18} />读取中…</div>;
  if (lines.length === 0) {
    return <div className="dbx-empty">这个对象没有源码（序列、同义词这类只有定义），切到「DDL」看它的定义</div>;
  }

  // 按 type 连续分组：PACKAGE 一段、PACKAGE BODY 一段（后端已按 type 排好序）
  const groups: { type: string; rows: SourceLine[] }[] = [];
  for (const l of lines) {
    const last = groups[groups.length - 1];
    if (last && last.type === l.type) last.rows.push(l);
    else groups.push({ type: l.type, rows: [l] });
  }
  const all = lines.map((l) => l.text).join("");

  return (
    <>
      <div className="dbx-rtool">
        <span className="meta">{lines.length} 行 · 只读（改库里的包请在库里执行，这里不编译也不回写）</span>
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn ghost" onClick={() => void navigator.clipboard.writeText(all).then(() => toast("已复制源码", "success"))}>
          <Icon name="copy" size={12} />
          复制全文
        </button>
      </div>
      <div className="dbx-src">
        {groups.map((g, gi) => (
          <div key={`${g.type}:${gi}`}>
            <div className="dbx-srchead">{g.type}</div>
            <pre className="dbx-ddl">
              {g.rows.map((l) => `${String(l.line).padStart(4, " ")}  ${l.text}`).join("")}
            </pre>
          </div>
        ))}
      </div>
    </>
  );
}
