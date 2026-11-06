import { lazy, Suspense, useEffect, useState } from "react";
import type { BmfArtifact, BmfArtifactStatus, BmfDetail, BmfGenPlan } from "../../lib/bmf";
import { generationTarget, type GenerationPreferences, type GenerationSnapshot } from "../../lib/bmfGeneration";
import { generationPath, generationSource, GENERATION_STATUSES, protectedArtifact } from "../../lib/metaGeneration";
import type { MetaSelection } from "../../lib/metaEditor";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";

const GenTextPreview = lazy(() => import("./GenTextPreview").then((m) => ({ default: m.GenTextPreview })));
interface Props {
  active: BmfArtifact | undefined; plan: BmfGenPlan; prefs: GenerationPreferences;
  status?: BmfArtifactStatus; snapshot: GenerationSnapshot | null; detail?: BmfDetail; disabled: boolean;
  onPreferences: (prefs: Partial<GenerationPreferences>, render?: boolean) => void; onLocate?: (selection: MetaSelection) => void;
}

export function GenFilePreview({ active, plan, prefs, status, snapshot, detail, disabled, onPreferences, onLocate }: Props) {
  const [original, setOriginal] = useState<{ snapshot: GenerationSnapshot | null; id: string; text: string | null; error: string | null; compared: boolean }>({ snapshot: null, id: "", text: null, error: null, compared: false });
  useEffect(() => {
    if (!active || !snapshot || prefs.pane !== "diff") return;
    let valid = true;
    void generationTarget(snapshot, active.id).then((text) => {
      if (valid) setOriginal({ snapshot, id: active.id, text, error: null, compared: false });
    }, (e) => { if (valid) setOriginal({ snapshot, id: active.id, text: null, error: String(e), compared: false }); });
    return () => { valid = false; };
  }, [snapshot, active, prefs.pane]);
  if (!active) return <section className="gen-preview"><div className="gen-empty">选择产物查看内容和差异</div></section>;
  const ready = original.snapshot === snapshot && original.id === active.id;
  const fullPath = snapshot?.targets.find((t) => t.id === active.id)?.resolvedPath || generationPath(prefs.root, active.pathHint);
  const needsDecision = protectedArtifact(status);
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast("已复制", "success"); } catch { toast("复制失败，剪贴板不可用", "error"); } };
  const scrollKey = `${active.id}:${prefs.pane}`;
  return <section className="gen-preview" aria-label="产物预览">
    <header className="gen-preview-head"><Icon name={active.kind === "ddl" ? "database" : "file"} size={15} /><strong>{active.name}</strong>
      <span className={`gen-file-status is-${status?.status ?? "unknown"}`}>{GENERATION_STATUSES[status?.status ?? ""] ?? "待检查"}</span>
      <small>{active.encoding} · {active.eol}</small><Button size="sm" variant="ghost" onClick={() => void copy(active.text)}><Icon name="copy" size={13} />复制内容</Button></header>
    <button className="gen-preview-path" type="button" title={`复制完整路径：${fullPath}`} onClick={() => void copy(fullPath)}>{fullPath}</button>
    <nav className="gen-preview-tabs" aria-label="预览内容">{([['content', '生成内容'], ['diff', '与现有文件比较'], ['sources', '来源与依赖']] as const).map(([pane, label]) =>
      <button type="button" key={pane} disabled={disabled} aria-pressed={prefs.pane === pane} onClick={() => onPreferences({ pane })}>{label}</button>)}</nav>
    {needsDecision && <div className="gen-protection"><span>{status?.detail}</span>{prefs.pane !== "diff" ? <button type="button" disabled={disabled} onClick={() => onPreferences({ pane: "diff" })}>查看差异</button> :
      <label className="gen-checkbox"><input type="checkbox" checked={prefs.overrides.includes(active.id)} disabled={disabled || !ready || original.text === null || !original.compared} onChange={(e) => onPreferences({
        overrides: e.target.checked ? [...prefs.overrides.filter((id) => id !== active.id), active.id] : prefs.overrides.filter((id) => id !== active.id),
        selected: e.target.checked ? [...new Set([...(prefs.selected ?? []), active.id])] : prefs.selected,
      })} />覆盖这个文件并备份</label>}</div>}
    {prefs.pane === "sources" ? <div className="gen-sources">
      <h3>来自当前 BMF</h3>{active.sourceRefs.length ? active.sourceRefs.map((id) => { const source = generationSource(detail, id); return <div key={id}>
        {source && onLocate ? <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onLocate(source.selection)}><Icon name="layers" size={13} />{source.label}</Button> : <code>{source?.label || id}</code>}</div>; }) : <p>此产物由组件整体生成。</p>}
      <h3>依赖产物</h3>{active.dependsOn.length ? active.dependsOn.map((id) => { const dep = plan.artifacts.find((a) => a.id === id); const chosen = prefs.selected?.includes(id); return <div key={id} className="gen-dependency"><span>{dep?.name || id}</span><small>{chosen ? "已选中" : "未选中，请核对目标工程"}</small>
        {dep && !chosen && <Button size="sm" variant="outline" disabled={disabled} onClick={() => onPreferences({ selected: [...(prefs.selected ?? []), id] })}>同时选择</Button>}</div>; }) : <p>没有声明产物依赖。</p>}
      {active.kind === "registry" && <p className="gen-protection">这是注册建议清单。菜单和模板等注册操作由后续发布流程处理。</p>}
    </div> : prefs.pane === "diff" && (!snapshot || !ready || original.text === null) ? <div className="gen-empty" role="status">{!snapshot ? "先更新产物并检查输出目录" : ready && original.error ? original.error : "正在读取原文件…"}</div> :
      <Suspense fallback={<pre className="gen-code-fallback">{active.text}</pre>}><GenTextPreview id={active.id} text={active.text}
        original={prefs.pane === "diff" ? original.text ?? "" : undefined} language={active.kind === "ddl" ? "sql" : active.family === "java" ? "java" : "plaintext"}
        onCompared={(compared) => setOriginal((prev) => prev.compared === compared ? prev : { ...prev, compared })}
        scrollTop={prefs.scroll[scrollKey] ?? 0} onScroll={(top) => onPreferences({ scroll: { ...prefs.scroll, [scrollKey]: top } }, false)} /></Suspense>}
  </section>;
}
