import type { BmfDetail } from "../../lib/bmf";

/** 顶部概览：组件身份、模块、文件编码与 SHA。只读，不参与任何写操作。 */
export function MetaOverview({ detail }: { detail: BmfDetail }) {
  return (
    <section className="meta-overview">
      <Info label="组件" value={`${detail.component.name} · ${detail.component.displayName || "—"}`} />
      <Info label="命名空间" value={detail.component.namespace || "—"} />
      <Info label="所属模块" value={detail.component.ownModule || "—"} />
      <Info label="版本 / 风格" value={`v${detail.component.version} · ${detail.component.genCodeStyle || "未声明"}`} />
      <Info
        label="文件"
        value={`${detail.encoding} ${detail.eol}${detail.bom ? " · BOM" : ""} · ${(detail.size / 1024).toFixed(1)} KB`}
        mono
      />
      <Info label="SHA-256" value={detail.sha256.slice(0, 16)} mono title={detail.sha256} />
    </section>
  );
}

function Info({ label, value, mono, title }: { label: string; value: string; mono?: boolean; title?: string }) {
  return (
    <div className="meta-info" title={title}>
      <span>{label}</span>
      <strong className={mono ? "meta-mono" : ""}>{value}</strong>
    </div>
  );
}
