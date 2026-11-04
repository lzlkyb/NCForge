import { useRef } from "react";
import { Icon } from "../ui/icon";
import { SvnCheckbox } from "./SvnCheckbox";
import { keyOf, letterTone, type ChangeItem } from "../../lib/svn";
import { clearSvnPicked, isSvnCommittable, isSvnPicked, selectSvnPaths, setSvnMessage, toggleSvnPicked, useSvnDraft } from "../../lib/svnDraft";
export function CommitPanel({ items, root = "", reviewed = new Set<string>(), busy, onSubmit, onCancel, onSelect }: { items: ChangeItem[]; root?: string; reviewed?: ReadonlySet<string>; hasConflict?: boolean; busy: boolean; onSubmit: (message: string, paths: string[]) => void; onCancel: () => void; onSelect?: (item: ChangeItem) => void }) {
  const draft = useSvnDraft(root), sending = useRef(false);
  const files = items.filter(isSvnCommittable), chosen = files.filter(f => isSvnPicked(draft.picked,f.path));
  const unreviewed = chosen.filter(f => !reviewed.has(keyOf(f.path))).length;
  const groups = new Map<string,ChangeItem[]>();
  for (const f of chosen) {
    const group = groups.get(f.module);
    if (group) group.push(f); else groups.set(f.module,[f]);
  }
  const canSubmit = !!root && !busy && !draft.unknown && chosen.length > 0 && !!draft.message.trim();
  const submit = () => {
    if (!canSubmit || sending.current) return;
    // 同帧点击与快捷键共用保护；整个异步链由工作副本写锁接管。
    sending.current = true; onSubmit(draft.message.trim(),chosen.map(f => f.path)); queueMicrotask(() => { sending.current = false; });
  };
  return <section className="vc-commit" aria-label="本次提交">
    <div className="vc-bar"><Icon name="upload" size={14} /><b>本次提交</b><span className="vc-sp" /><button type="button" className="vc-btn vc-btn-icon" aria-label="收起提交区" onClick={onCancel}><Icon name="close" size={14} /></button></div>
    <div className="vc-commit-body">
      <label className="vc-label" htmlFor="svn-commit-message">提交说明<span className="vc-sp" /><span className="vc-hint">草稿自动保留</span></label>
      <textarea id="svn-commit-message" className="vc-msg" aria-label="提交说明" value={draft.message} disabled={!root || busy || !!draft.unknown} placeholder="说明这次修改的内容与原因" spellCheck={false} onChange={e => setSvnMessage(root,e.target.value)} onKeyDown={e => { if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return; if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); submit(); } }} />
      <div className="vc-commit-summary"><b>已选 {chosen.length} / {files.length} 个文件</b><span>{unreviewed ? `${unreviewed} 个尚未标记已审` : chosen.length ? "所选文件均已审查" : "在文件清单勾选本次提交内容"}</span></div>
      {items.some(f => f.letter === "C") && <div className="vc-alert" data-tone="warn"><Icon name="alertTriangle" size={13} /><span>冲突文件已排除，其他所选文件仍可提交。</span></div>}
      <div className="vc-selection-tools">
        <SvnCheckbox label="选择全部可提交文件" checked={files.length > 0 && chosen.length === files.length} mixed={chosen.length > 0 && chosen.length < files.length} disabled={busy || !!draft.unknown || !files.length} onChange={() => chosen.length === files.length ? clearSvnPicked(root) : selectSvnPaths(root,files.map(f => f.path))} />
        <button type="button" className="vc-chip" disabled={busy || !!draft.unknown || !files.length} onClick={() => selectSvnPaths(root,files.map(f => f.path))}>全选</button>
        <button type="button" className="vc-chip" disabled={busy || !!draft.unknown || !chosen.length} onClick={() => clearSvnPicked(root)}>清空</button>
        <button type="button" className="vc-chip" disabled={busy || !!draft.unknown} onClick={() => selectSvnPaths(root,files.filter(f => reviewed.has(keyOf(f.path))).map(f => f.path))}>只选已审</button>
      </div>
      <div className="vc-commit-files">{[...groups].map(([module,entries]) => <div key={module}><div className="vc-commit-module">{module}<span>{entries.length}</span></div>{entries.map(f => <div className="vc-commit-file" key={f.path}>
        <SvnCheckbox label={`提交 ${f.rel}`} checked disabled={busy || !!draft.unknown} onChange={() => toggleSvnPicked(root,f.path)} />
        <span className="vc-badge" data-st={letterTone(f.letter)}>{f.letter}</span><button type="button" className="vc-commit-path" title={f.rel} onClick={() => onSelect?.(f)}>{f.rel}</button>{reviewed.has(keyOf(f.path)) && <Icon name="check" size={12} />}
      </div>)}</div>)}</div>
      {!chosen.length && <div className="vc-empty"><Icon name="check" size={22} /><span>尚未选择文件<br />选择范围会跨筛选保留</span></div>}
      <p className="vc-hint">提交包含磁盘上的内容；未保存编辑会在提交前确认。</p>
    </div>
    <div className="vc-commit-foot"><span className="vc-hint">Ctrl+Enter 提交</span><span className="vc-sp" /><button type="button" className="vc-btn vc-btn-primary" disabled={!canSubmit} onClick={submit}>{busy ? <Icon name="spinner" size={12} className="animate-spin" /> : <Icon name="upload" size={12} />}{busy ? "处理中…" : `提交 ${chosen.length} 个文件`}</button></div>
  </section>;
}
