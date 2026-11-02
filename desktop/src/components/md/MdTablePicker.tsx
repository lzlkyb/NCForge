import { Icon } from "../ui/icon";
import { Spinner } from "../ui/Spinner";
import type { PickRow } from "../../lib/mdDict";

/**
 * 左栏选表器。
 *
 * 「勾选表」与「补丁涉及」共用它——两种模式下 rows 来自不同地方（一个来自关键词查询，
 * 一个来自补丁草稿扫表），但「怎么显示、怎么勾」是同一件事，不做两套。
 *
 * 行高刻意压到 22px：一次要能扫过几十张表，行距大了就得滚。
 */
export function MdTablePicker({
  rows,
  selected,
  keyword,
  onKeyword,
  onToggle,
  onAll,
  onNone,
  busy,
  error,
  truncated,
  emptyTitle,
  emptyHint,
}: {
  rows: PickRow[];
  /** 已勾选的表名（小写）。 */
  selected: Set<string>;
  keyword: string;
  onKeyword: (v: string) => void;
  onToggle: (name: string) => void;
  onAll: () => void;
  onNone: () => void;
  busy: boolean;
  error: string | null;
  truncated: boolean;
  emptyTitle: string;
  emptyHint?: string;
}) {
  const selectable = rows.filter((r) => !r.missing);
  const allPicked = selectable.length > 0 && selectable.every((r) => selected.has(r.name.toLowerCase()));

  return (
    <div className="md-pick">
      <div className="md-find">
        <input
          value={keyword}
          onChange={(e) => onKeyword(e.target.value)}
          placeholder="表名或中文名，如 物料"
          spellCheck={false}
          aria-label="按表名或中文名找表"
        />
      </div>
      <div className="md-pick-bar">
        <span>
          已选 {selected.size} 张 · 上限 500
        </span>
        {selectable.length > 0 && (
          <button type="button" className="md-link" onClick={allPicked ? onNone : onAll}>
            {allPicked ? "全不选" : `全选当前 ${selectable.length} 张`}
          </button>
        )}
      </div>
      <div className="md-pick-list">
        {busy ? (
          <div className="md-fill" style={{ justifyContent: "flex-start", paddingTop: 18 }}>
            <Spinner size={14} />
            <p>正在找表…</p>
          </div>
        ) : error ? (
          <div className="md-fill" data-tone="bad" style={{ justifyContent: "flex-start", paddingTop: 18 }}>
            <Icon name="alertTriangle" size={15} />
            <p>{error}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="md-fill" style={{ justifyContent: "flex-start", paddingTop: 18 }}>
            <p>
              <b>{emptyTitle}</b>
            </p>
            {emptyHint && <p>{emptyHint}</p>}
          </div>
        ) : (
          <>
            {rows.map((r) => {
              const key = r.name.toLowerCase();
              const on = !r.missing && selected.has(key);
              return (
                <button
                  key={r.name}
                  type="button"
                  className="md-pick-item"
                  data-on={on || undefined}
                  data-off={r.missing || undefined}
                  disabled={r.missing}
                  aria-pressed={on}
                  title={r.missing ? `${r.name}：库里没有这张表` : `${r.name} ${r.displayName}`}
                  onClick={() => onToggle(r.name)}
                >
                  <span className="md-ck" aria-hidden="true">
                    {on && <Icon name="check" size={10} />}
                  </span>
                  <span className="md-name">{r.name}</span>
                  {r.missing ? (
                    <span className="md-tag-miss">库里没有</span>
                  ) : (
                    <>
                      <span className="md-cn">{r.displayName || "—"}</span>
                      {r.isExtend && <span className="md-tag-ext">扩展</span>}
                      {r.module && <span className="md-mod">{r.module}</span>}
                    </>
                  )}
                </button>
              );
            })}
            {truncated && (
              <p style={{ padding: "6px 8px", fontSize: 11, color: "hsl(var(--muted-foreground))" }}>
                只列出了前 {rows.length} 张。把关键词写细一点（如 `bd_mat`）能继续缩小。
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
