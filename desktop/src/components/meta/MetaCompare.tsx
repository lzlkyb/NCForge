import { useEffect, useMemo, useState } from "react";
import { bmfDetail, type BmfDetail, type BmfEntry } from "../../lib/bmf";
import { diffDetails, summarize } from "../../lib/bmfDiff";
import { normalizeBmfPath } from "../../lib/bmfPath";
import { MetaDiffRows } from "./MetaDiffRows";
import { MetaNcCompare } from "./MetaNcCompare";

/**
 * 结构对比（M7/F2）：当前组件 vs 索引里任意另一个 BMF。
 *
 * 对比对象来自索引，所以「另一个工程里的同名组件」「手工保留的旧版本副本」都能用。
 * 只比语义结构（见 `diffDetails`），不比字节；不做「一键改成对方」——回写仍走编辑弹框，
 * 每一处都必须看过 diff。
 */
export function MetaCompare({ current, entries }: { current: BmfDetail; entries: BmfEntry[] }) {
  const [otherPath, setOtherPath] = useState("");
  const [other, setOther] = useState<BmfDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const options = useMemo(
    () => entries.filter((e) => normalizeBmfPath(e.path) !== normalizeBmfPath(current.path)),
    [entries, current.path],
  );

  useEffect(() => {
    if (!otherPath) {
      setOther(null);
      return;
    }
    let alive = true;
    setBusy(true);
    setErr(null);
    bmfDetail(otherPath)
      .then((d) => {
        if (alive) setOther(d);
      })
      .catch((e) => {
        if (alive) {
          setOther(null);
          setErr(String(e));
        }
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [otherPath]);

  const rows = useMemo(() => (other ? diffDetails(current, other) : []), [current, other]);
  const sum = summarize(rows);

  return (
    <div className="meta-compare">
      <div className="meta-compare-bar">
        <span className="meta-export-label">对比对象</span>
        <select
          className="meta-ddl-conn"
          aria-label="选择对比的 BMF"
          value={otherPath}
          onChange={(e) => setOtherPath(e.target.value)}
        >
          <option value="">选择另一个组件 / 旧版本…</option>
          {options.map((e) => (
            <option key={e.path} value={e.path}>
              {e.origin} · {e.name} v{e.version}
            </option>
          ))}
        </select>
        {other && (
          <span className="meta-note m-0">
            {current.component.name} v{current.component.version} → {other.component.name} v
            {other.component.version}
          </span>
        )}
        {other && rows.length > 0 && (
          <span className="meta-compare-sum">
            <span className="is-added">+{sum.added}</span>
            <span className="is-removed">−{sum.removed}</span>
            <span className="is-changed">~{sum.changed}</span>
          </span>
        )}
      </div>

      {busy && <p className="meta-note">正在解析对比对象…</p>}
      {err && <p className="meta-error">{err}</p>}

      {other && !busy && rows.length === 0 && (
        <p className="meta-note">两份组件的语义结构一致（实体 / 字段 / 枚举 / 关系层面没有差异）。</p>
      )}

      {other && !busy && rows.length > 0 && <MetaDiffRows rows={rows} />}

      {!other && !busy && (
        <p className="meta-note">选一个对比对象后，会按实体、字段、枚举、关系逐项列出差异；不写任何文件。</p>
      )}

      <MetaNcCompare current={current} />
    </div>
  );
}
