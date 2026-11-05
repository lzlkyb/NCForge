import { useMemo, useState } from "react";
import { bmfNchomeCompare, type BmfDetail, type BmfNcCompare } from "../../lib/bmf";
import { diffDetails, summarize } from "../../lib/bmfDiff";
import { Button } from "../ui/button";
import { MetaDiffRows } from "./MetaDiffRows";

/**
 * F3：当前工作区组件 vs NC 安装目录里的同名组件。
 *
 * 方向固定「工作区 → 安装目录」：新增 = 安装目录有、工作区没有；
 * 删除 = 工作区有、安装目录没有。
 * 只读：后端只读 NCHOME 各模块的 METADATA 目录，不会写入安装目录。
 */
export function MetaNcCompare({ current }: { current: BmfDetail }) {
  const [nc, setNc] = useState<BmfNcCompare | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = (installPath?: string) => {
    setBusy(true);
    setErr(null);
    bmfNchomeCompare(current.path, current.component.name, installPath)
      .then((r) => setNc(r))
      .catch((e) => {
        setNc(null);
        setErr(String(e));
      })
      .finally(() => setBusy(false));
  };

  const rows = useMemo(() => (nc?.detail ? diffDetails(current, nc.detail) : []), [current, nc]);
  const sum = summarize(rows);
  const single = nc && nc.candidates.length === 1 ? nc.candidates[0] : null;

  return (
    <section className="meta-nc" aria-label="NC 安装目录只读对比">
      <div className="meta-nc-bar">
        <span className="meta-export-label">NC 安装目录</span>
        <span className="meta-nc-kind" title="只读：不会写入 NC 安装目录">
          只读
        </span>
        {nc && <span className="meta-nc-home">{nc.ncHome}</span>}
        <Button size="sm" variant="outline" onClick={() => load()} disabled={busy}>
          {busy ? "读取中…" : nc ? "重新读取" : "对比同名组件"}
        </Button>
      </div>

      {err && <p className="meta-error">{err}</p>}

      {nc && nc.candidates.length === 0 && (
        <p className="meta-note m-0">
          安装目录里没有 {nc.component}.bmf（按文件名在各模块 METADATA 下查找，已确认 NC home 可读）。
          同名组件可能未安装，或文件名与组件编码不一致。
        </p>
      )}

      {nc && nc.candidates.length > 1 && (
        <select
          className="meta-ddl-conn"
          aria-label="选择安装目录中的副本"
          value={nc.selected ?? ""}
          onChange={(e) => load(e.target.value)}
          disabled={busy}
        >
          {nc.candidates.map((c) => (
            <option key={c.path} value={c.path}>
              {c.module} · {c.path}
            </option>
          ))}
        </select>
      )}

      {nc && nc.detail && (
        <>
          <div className="meta-compare-bar">
            <span className="meta-note m-0">
              {single ? `${single.module} 模块 · ` : ""}
              工作区 v{current.component.version} → 安装目录 v{nc.detail.component.version}
            </span>
            {rows.length > 0 && (
              <span className="meta-compare-sum">
                <span className="is-added">+{sum.added}</span>
                <span className="is-removed">−{sum.removed}</span>
                <span className="is-changed">~{sum.changed}</span>
              </span>
            )}
          </div>
          {rows.length === 0 ? (
            <p className="meta-note m-0">
              工作区与安装目录的语义结构一致；安装目录里的版本号不影响结构对比。
            </p>
          ) : (
            <>
              <p className="meta-note m-0">
                新增 = 安装目录有、工作区没有；删除 = 工作区有、安装目录没有。修改变更需回工作区编辑，工具不会改安装目录。
              </p>
              <MetaDiffRows rows={rows} />
            </>
          )}
        </>
      )}

      {!nc && !busy && !err && (
        <p className="meta-note m-0">
          从 NC home 的 modules/*/METADATA 找同名 BMF，与工作区版本做字段级对比。只读，不写安装目录。
        </p>
      )}
    </section>
  );
}
