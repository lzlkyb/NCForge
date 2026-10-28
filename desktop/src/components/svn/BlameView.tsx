import { useMemo } from "react";
import { Icon } from "../ui/icon";
import { formatRevTime, type BlameLine } from "../../lib/svn";

/** 作者色相：同一个人固定同一个颜色，靠名字哈希，不依赖后端。 */
function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

const MAX_LINES = 4000;

/**
 * Blame：每行谁在哪个版本改的。
 *
 * 正文不重复从后端传（`svn_blame` 只回每行的 revision/author/date），
 * 直接复用已经加载的工作副本正文——省一次 IO，也保证和差异面板看到的是同一份内容。
 */
export function BlameView({
  title,
  text,
  lines,
  loading,
  error,
  onShowDiff,
}: {
  title: string;
  text: string;
  lines: BlameLine[] | undefined;
  loading: boolean;
  error: string | null;
  onShowDiff: () => void;
}) {
  const rows = useMemo(() => {
    const src = text.split("\n");
    if (!lines) return [];
    const n = Math.min(src.length, lines.length);
    const out: { ln: number; code: string; info: BlameLine | undefined }[] = [];
    for (let i = 0; i < n; i += 1) out.push({ ln: i + 1, code: src[i], info: lines[i] });
    return out;
  }, [text, lines]);

  const summary = useMemo(() => {
    if (!lines || lines.length === 0) return null;
    const authors = new Set<string>();
    const revs = new Set<number>();
    let latest = 0;
    for (const l of lines) {
      authors.add(l.author);
      revs.add(l.revision);
      if (l.date > latest) latest = l.date;
    }
    return { authors: authors.size, revs: revs.size, latest };
  }, [lines]);

  return (
    <section className="vc-main">
      <div className="vc-bar">
        <Icon name="user" size={14} />
        <b>Blame</b>
        <span className="vc-path">{title}</span>
        <span className="vc-sp" />
        <button type="button" className="vc-btn vc-btn-sm" onClick={onShowDiff}>
          回到差异
        </button>
      </div>

      {summary && (
        <div className="vc-blame-strip">
          <span>{rows.length} 行</span>
          <span>{summary.revs} 个版本</span>
          <span>{summary.authors} 位作者</span>
          <span className="vc-sp" />
          <span>最近改动 {formatRevTime(summary.latest)}</span>
        </div>
      )}

      <div className="vc-log">
        {loading && (
          <div className="vc-empty">
            <Icon name="spinner" size={20} className="vc-spin" />
            <div>正在算 blame…（大文件要几秒）</div>
          </div>
        )}

        {!loading && error && (
          <div style={{ padding: 12 }}>
            <div className="vc-alert" data-tone="warn">
              <Icon name="alert" size={13} />
              <span>{error}</span>
            </div>
          </div>
        )}

        {!loading && !error && rows.length > 0 && (
          <div className="vc-blame">
            {rows.slice(0, MAX_LINES).map((r) => (
              <div className="vc-blame-row" key={r.ln}>
                <span
                  className="vc-blame-g"
                  style={{ background: `hsl(${hueOf(r.info?.author ?? "")} 68% 48% / 0.75)` }}
                />
                <span className="vc-blame-rev">{r.info ? `r${r.info.revision}` : "—"}</span>
                <span className="vc-blame-who" title={r.info ? formatRevTime(r.info.date) : ""}>
                  {r.info?.author ?? "—"}
                </span>
                <span className="vc-blame-ln">{r.ln}</span>
                <span className="vc-blame-tx">{r.code === "" ? " " : r.code}</span>
              </div>
            ))}
            {rows.length > MAX_LINES && (
              <div className="vc-hint" style={{ padding: "8px 12px" }}>
                文件有 {rows.length} 行，只显示前 {MAX_LINES} 行（再往下渲染会卡）
              </div>
            )}
          </div>
        )}

        {!loading && !error && rows.length === 0 && (
          <div className="vc-empty">
            <Icon name="user" size={22} />
            <div>没有 blame 数据：新文件或还没提交过</div>
          </div>
        )}
      </div>
    </section>
  );
}
