import { useMemo } from "react";
import { Icon } from "../ui/icon";
import { EmptyState } from "../ui/EmptyState";
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
 * 直接复用已经加载的工作副本正文——省一次 IO，也和差异面板看到的是同一份内容。
 *
 * ⚠️ 但「同一份内容」只对正文成立，**行信息对不上**：annotate 按 SVN 的口径永远
 * 基于 HEAD 版本，而正文是磁盘上的工作副本。文件有本地增删行时，第一处改动之后
 * `src[i] ↔ lines[i]` 全部错位，作者/版本/日期集体张冠李戴且没有任何征兆。
 * 因此这里在行数不一致或文件有本地改动时都要明确警告——用户拿 blame 定责，
 * 错一行就是错一个人。
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

  /** 行数不一致 = 已确定错位（不是「可能」）：HEAD 与工作副本不是同一份文件。 */
  const drift = !!lines && lines.length > 0 && text.split("\n").length !== lines.length;

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

      {!loading && !error && (
        <div style={{ padding: "10px 12px 0" }}>
          {drift ? (
            <div className="vc-alert" data-tone="warn">
              <Icon name="alert" size={13} />
              <span>
                行号已错位：HEAD 的这份文件 {lines?.length ?? 0} 行，工作副本{" "}
                {text.split("\n").length} 行。从第一处增删行开始，下面的作者与版本都不再属于这一行。
              </span>
            </div>
          ) : (
            <div className="vc-hint">
              行信息来自 HEAD 版本，正文是工作副本。这个文件有本地改动——行数一旦变化就会整体错位。
            </div>
          )}
        </div>
      )}

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
            <Icon name="spinner" size={20} className="animate-spin" />
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
          <EmptyState
            icon="user"
            description="这个路径还没有 blame 数据（新文件或还没提交过）"
            bigIconSize={44}
            iconSize={20}
            className="py-6"
          />
        )}
      </div>
    </section>
  );
}
