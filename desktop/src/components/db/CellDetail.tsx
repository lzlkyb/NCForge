import { useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import type { Cell, ColumnMeta } from "../../lib/dbApi";

function prettyJson(s: string): string | null {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

/** 单元格详情：长文本 / CLOB 看全，可切 JSON 格式化。 */
export function CellDetail({ column, zh, row, value, empty, onClose }: {
  column: ColumnMeta | null;
  zh?: string;
  row: number | null;
  value: Cell;
  empty: boolean;
  onClose: () => void;
}) {
  const [json, setJson] = useState(false);
  const text = value === null ? "" : String(value);
  const pretty = json ? prettyJson(text) : null;
  return (
    <div className="dbx-detail">
      <div className="hd">
        <div style={{ flex: 1, minWidth: 0 }}>
          {empty || !column ? (
            <span className="dbx-muted">点一个单元格看全文</span>
          ) : (
            <>
              <b>{column.name.toLowerCase()}</b>
              <div className="s">
                {[zh, column.type, `第 ${row} 行`, value === null ? "NULL" : `${text.length} 字符`].filter(Boolean).join(" · ")}
              </div>
            </>
          )}
        </div>
        <button type="button" className="dbx-ibtn" aria-label="关闭详情" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <pre className={value === null ? "dbx-muted" : undefined}>{empty ? "" : value === null ? "NULL" : (pretty ?? text)}</pre>
      <div className="ft">
        <button type="button" className="dbx-btn ghost" disabled={empty || value === null} onClick={() => void navigator.clipboard.writeText(text).then(() => toast("已复制", "success"))}>
          <Icon name="copy" size={12} />
          复制
        </button>
        <button type="button" className="dbx-btn ghost" data-on={json || undefined} disabled={!prettyJson(text)} onClick={() => setJson(!json)}>
          JSON 格式化
        </button>
      </div>
    </div>
  );
}
