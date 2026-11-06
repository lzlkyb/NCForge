import { useEffect, useReducer } from "react";
import type { BmfDetail } from "../../lib/bmf";
import { generationReveal, type GenerationPreferences } from "../../lib/bmfGeneration";
import { generationPath } from "../../lib/metaGeneration";
import type { MetaSelection } from "../../lib/metaEditor";
import { requestOpenFile } from "../../lib/openFileRequest";
import { useMetaGeneration } from "../../hooks/useMetaGeneration";
import { useGenerationLayout } from "../../hooks/useGenerationLayout";
import { useViewActive } from "../../lib/viewActivity";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { GenArtifacts } from "./GenArtifacts";
import { GenFilePreview } from "./GenFilePreview";
import { GenConfigBar } from "./GenConfigBar";
import { GenWriteDialogs, type GenerationReview } from "./GenWriteDialogs";
import { MetaDdlRun } from "./MetaDdlRun";
import "../../meta-generation.css";

interface Props {
  path: string; component?: string; detail?: BmfDetail; preferences?: GenerationPreferences;
  onPreferences?: (prefs: GenerationPreferences) => void; onBack?: (issues?: boolean) => void;
  onLocate?: (selection: MetaSelection) => void; onApplying?: (applying: boolean) => void;
}
interface Panels { config: boolean; list: boolean; review: GenerationReview | null; result: boolean;
  ddl: { text: string; component: string; dialect: string } | null; ddlRunning: boolean }

export function MetaGenerate({ path, component, detail, preferences, onPreferences, onBack, onLocate, onApplying }: Props) {
  const gen = useMetaGeneration(path, preferences, detail?.sha256, onPreferences);
  const layout = useGenerationLayout();
  const viewActive = useViewActive();
  const [panels, setPanels] = useReducer((s: Panels, patch: Partial<Panels>) => ({ ...s, ...patch }), { config: false, list: false, review: null, result: false, ddl: null, ddlRunning: false });
  const working = gen.applying || panels.ddlRunning;
  useEffect(() => { onApplying?.(working); return () => onApplying?.(false); }, [working, onApplying]);
  const name = component || path.replace(/^.*[\\/]/, "").replace(/\.bmf$/i, "");
  const active = gen.plan?.artifacts.find((a) => a.id === gen.prefs.activeId);
  const errors = gen.issues?.filter((i) => i.severity === "error").length ?? 0;
  const warnings = gen.issues?.filter((i) => i.severity === "warn").length ?? 0;
  const changePrefs = (prefs: Partial<GenerationPreferences>, render = true) => {
    if (working) return;
    gen.setPreferences(prefs, render);
    if (prefs.activeId) setPanels({ list: false });
  };
  const reveal = (file: string) => void generationReveal(file).catch((e) => toast(`打开目录失败：${e}`, "error"));
  const open = (file: string) => { requestOpenFile({ path: file }); window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "files" })); };
  const confirm = async () => {
    const review = panels.review;
    if (!review) return;
    const ok = await gen.apply(review.snapshot, review.selected, review.overrides);
    setPanels({ review: null, result: ok });
  };
  const closeDdl = () => { if (!panels.ddlRunning) setPanels({ ddl: null }); };
  const config = gen.profile ? <GenConfigBar profile={gen.profile} root={gen.root} component={name} disabled={working}
    updating={gen.busy} checking={gen.checking} checked={!!gen.snapshot} dirty={gen.dirty} checkError={gen.diffErr}
    onChange={(profile) => gen.setPreferences({ profile })} onRoot={gen.setRoot} onPick={() => void gen.pick()} onCheck={() => void gen.check()} onGenerate={() => void gen.generate()} /> :
    <p className="gen-note">{gen.busy ? "正在载入 BMF 配置…" : "请更新产物，载入生成配置"}</p>;
  return <div className="gen-workbench" ref={layout.ref} data-layout={layout.mode} data-active={viewActive || undefined} aria-busy={gen.busy || working}>
    <header className="gen-workbench-head"><Button size="sm" variant="ghost" disabled={working} onClick={() => onBack?.()}><Icon name="chevronLeft" size={14} />返回元数据</Button>
      <div className="gen-context"><strong>{detail?.component.displayName || name} · 整套生成</strong><small title={path}>{name}.bmf · 已保存</small></div>
      <ol className="gen-steps" aria-label="生成步骤"><li className={gen.dirty ? "is-current" : ""}>配置</li><li className={!gen.dirty && !gen.result && !gen.applying ? "is-current" : ""}>产物与差异</li><li className={gen.applying || panels.review ? "is-current" : ""}>写入</li><li className={gen.result ? "is-current" : ""}>结果</li></ol>
      {layout.mode !== "wide" && <Button size="sm" variant="outline" disabled={working} onClick={() => setPanels({ config: true })}><Icon name="settings" size={14} />配置</Button>}
      <Button size="sm" variant="ghost" disabled={gen.busy || working} onClick={() => void gen.generate()} title="重新读取 BMF 并更新产物"><Icon name="refresh" size={14} /><span className="gen-refresh-label">更新产物</span></Button>
    </header>
    {gen.err && <p className="gen-error" role="alert">{gen.err}</p>}
    {gen.dirty && <p className="gen-state-note gen-warning" role="status">配置已修改。当前显示上次预览，更新产物后可写入。</p>}
    {gen.busy && <p className="gen-state-note" role="status">正在解析、校验并更新产物…</p>}
    {layout.mode === "narrow" && <div className="gen-mobile-tabs"><button type="button" disabled={working} aria-pressed={panels.list} onClick={() => setPanels({ list: true })}>产物清单</button><button type="button" disabled={working} aria-pressed={!panels.list} onClick={() => setPanels({ list: false })}>内容预览</button></div>}
    <div className="gen-workbench-body">
      {gen.plan ? <>
        {(layout.mode !== "narrow" || panels.list) && <GenArtifacts plan={gen.plan} statuses={gen.statuses} prefs={gen.prefs} disabled={working} onPreferences={changePrefs} onOpenOld={(relative) => open(generationPath(gen.root, relative))} />}
        {(layout.mode !== "narrow" || !panels.list) && <GenFilePreview active={active} plan={gen.plan} prefs={gen.prefs} snapshot={gen.snapshot} status={active ? gen.statuses[active.id] : undefined} detail={detail} disabled={working} onPreferences={changePrefs} onLocate={onLocate} />}
      </> : <div className="gen-empty"><Icon name="layers" size={28} /><strong>{gen.busy ? "准备当前 BMF 的整套产物" : "生成预览尚未就绪"}</strong><span>{gen.busy ? "完成后可查看代码、脚本和来源" : "确认源文件可读后重新更新产物"}</span></div>}
      {layout.mode === "wide" && <aside className="gen-config-aside"><h3>生成配置</h3>{config}
        {gen.issues && <div className={`gen-validation ${errors ? "gen-warning" : "gen-ok"}`}>规则校验：{errors} 错误 · {warnings} 警告{(errors > 0 || warnings > 0) && <button type="button" disabled={working} onClick={() => onBack?.(true)}>查看问题</button>}</div>}
        <details className="gen-diagnostics"><summary>生成说明与诊断{gen.plan?.warnings.length ? ` · ${gen.plan.warnings.length} 项提示` : ""}</summary>
          {gen.plan?.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
          {gen.plan && <p>解析 {Math.round(gen.plan.timings.parseMs)}ms · 校验 {Math.round(gen.plan.timings.validateMs)}ms · 渲染 {Math.round(gen.plan.timings.renderMs)}ms · 对比 {Math.round(gen.diffMs ?? 0)}ms</p>}
        </details></aside>}
    </div>
    <footer className="gen-workbench-foot"><div className="gen-write-summary"><strong>已选 {gen.counts.selected}</strong><span>新建 {gen.counts.create} · 更新 {gen.counts.update} · 保留 {gen.counts.keep} · 一致 {gen.counts.same}</span>
      <small title={gen.blockedReason || "预览和输出目录已检查"}>{gen.applying ? "正在逐文件核对、备份并写入…" : panels.ddlRunning ? "正在测试库执行生成脚本…" : gen.blockedReason || "预览与目录已检查，可以确认写入"}</small></div>
      {errors > 0 && <Button size="sm" variant="outline" disabled={working} onClick={() => onBack?.(true)}>修复校验问题</Button>}
      {gen.result && <Button size="sm" variant="outline" onClick={() => setPanels({ result: true })}>查看写入结果</Button>}
      {active?.kind === "ddl" && gen.result && <Button size="sm" variant="outline" disabled={working || gen.dirty || gen.busy} onClick={() => setPanels({ ddl: { text: active.text, component: name, dialect: gen.plan!.profile.dialect } })}>测试库执行…</Button>}
      <Button size="sm" disabled={working || gen.busy || (!!gen.blockedReason && !gen.dirty)} onClick={() => { if (gen.dirty) void gen.generate(); else if (gen.snapshot) setPanels({ review: { snapshot: gen.snapshot, selected: [...(gen.prefs.selected ?? [])], overrides: [...gen.prefs.overrides] } }); }}>
        <Icon name="download" size={14} />{gen.applying ? "写入中…" : gen.dirty ? "更新产物" : "检查并确认写入"}</Button>
    </footer>
    <Modal open={layout.mode !== "wide" && panels.config} onClose={() => setPanels({ config: false })} ariaLabel="生成配置" className="gen-config-modal modal-surface"><header className="gen-modal-head"><h3>生成配置</h3><Button size="sm" variant="ghost" onClick={() => setPanels({ config: false })} aria-label="关闭生成配置"><Icon name="close" size={16} /></Button></header>{config}
      {gen.issues && <p className="gen-validation">规则校验：{errors} 错误 · {warnings} 警告</p>}{gen.plan?.warnings.map((w, i) => <p key={i} className="gen-note">{w}</p>)}
    </Modal>
    <GenWriteDialogs plan={gen.plan} statuses={gen.statuses} review={panels.review} result={gen.result} resultOpen={panels.result} root={gen.result?.root || gen.root} applying={gen.applying}
      onCloseReview={() => setPanels({ review: null })} onConfirm={() => void confirm()} onCloseResult={() => setPanels({ result: false })} onOpen={open} onReveal={reveal} />
    <Modal open={!!panels.ddl} onClose={closeDdl} closeOnOverlay={!panels.ddlRunning} keepMountedWhenInactive ariaLabel="生成脚本测试库执行" className="gen-modal modal-surface"><header className="gen-modal-head"><h3>生成脚本测试库执行</h3><Button size="sm" variant="ghost" disabled={panels.ddlRunning} onClick={closeDdl} aria-label="关闭脚本执行"><Icon name="close" size={16} /></Button></header><p className="gen-note">来源：{panels.ddl?.component}.bmf · 方言：{panels.ddl?.dialect}{panels.ddlRunning && " · 正在执行，请等待结果后关闭"}</p>{panels.ddl && <MetaDdlRun ddl={panels.ddl.text} component={panels.ddl.component} onRunning={(ddlRunning) => setPanels({ ddlRunning })} />}</Modal>
  </div>;
}
