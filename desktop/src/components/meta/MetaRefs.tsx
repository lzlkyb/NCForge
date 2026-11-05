import { useState } from "react";
import { bmfReferences, type BmfRefScan } from "../../lib/bmf";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

/**
 * 跨工程引用（F1，只读）。
 *
 * 显式点「扫描」而不是进页面就扫：要解析索引里的每一份 BMF，大工程上是秒级操作，
 * 不能让切个页签就触发。判据只有类全名（见 `bmf_refs.rs`），不做模糊匹配。
 */
export function MetaRefs({ path, onOpen }: { path: string; onOpen?: (path: string) => void }) {
  const [scan, setScan] = useState<BmfRefScan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setScan(await bmfReferences(path));
    } catch (e) {
      setScan(null);
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="meta-refs">
      <div className="meta-refs-bar">
        <p className="meta-note m-0">
          引用关系来自其他组件字段的 <code>typeName</code> / <code>refModelName</code>；按类全名匹配。
        </p>
        <Button size="sm" variant="outline" onClick={() => void run()} disabled={busy}>
          <Icon name="gitBranch" size={13} /> {busy ? "扫描中…" : "扫描引用"}
        </Button>
      </div>

      {err && <p className="meta-error">{err}</p>}

      {scan && !busy && (
        <>
          <p className="meta-note">
            扫描 {scan.scanned} 个组件，命中 {scan.hits.length} 处
            {scan.skipped > 0 && `，跳过 ${scan.skipped} 个无法解析的文件`}
            {scan.truncated && `（超过上限 ${scan.hits.length} 条，已截断）`}
          </p>
          {scan.hits.length === 0 ? (
            <p className="meta-note">没有组件引用本组件的实体或枚举。</p>
          ) : (
            <div className="meta-compare-rows">
              {scan.hits.map((h, i) => (
                <div className="meta-ref-row" key={`${h.path}-${h.entity}-${h.attr}-${i}`}>
                  <span className="meta-compare-kind">{h.component}</span>
                  <span className="meta-compare-scope">
                    {h.entity}.{h.attr}
                  </span>
                  <code className="meta-ref-field">
                    {h.field}={h.value}
                  </code>
                  <span className="meta-ref-path" title={h.path}>
                    {h.path}
                  </span>
                  {onOpen && (
                    <button type="button" className="meta-link" onClick={() => onOpen(h.path)}>
                      打开
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {!scan && !busy && !err && (
        <p className="meta-note">点「扫描引用」列出其他组件在哪些字段上引用了本组件。</p>
      )}
    </div>
  );
}
