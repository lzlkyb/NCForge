import { useState } from "react";
import { Icon } from "../ui/icon";
import { useSvnDraft } from "../../lib/svnDraft";
import { useRequirements } from "../../lib/requirements";
import { requirementsForPaths } from "../../lib/reqGroups";
import { keyOf } from "../../lib/svn";
import type { HistoryEntry } from "../../lib/svnHistory";
import { toast } from "../ui/toast";

export function RevisionPatchPreview({ root, repositoryPath, entry, onClose }: { root: string; repositoryPath: string; entry: HistoryEntry; onClose: () => void }) {
  const [checked,setChecked] = useState(false);
  const { lastCommit } = useSvnDraft(root), { view } = useRequirements();
  const prefix = repositoryPath === "/" ? "/" : repositoryPath + "/";
  const paths = entry.paths.filter(change => change.path.startsWith(prefix));
  const absolute = paths.map(change => root.replace(/[\\/]+$/,"") + "/" + change.path.slice(prefix.length));
  const current = requirementsForPaths(view,absolute);
  const saved = lastCommit?.revision === entry.revision ? lastCommit.requirements : undefined;
  const rows = paths.map((change,index) => ({ ...change, names:saved?.[keyOf(absolute[index])] ?? current[keyOf(absolute[index])] ?? [] }));
  const mixed = rows.filter(row => row.names.length > 1);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText([`r${entry.revision} · ${entry.message}`,...rows.map(row => `${row.action}\t${row.path}`)].join("\n"));
      toast("已复制此版本的改动路径","success");
    } catch { toast("复制失败，请检查剪贴板权限","error"); }
  };
  return <aside className="vc-remote-confirm vc-revision-patch" aria-label="NC 补丁预览">
    <div className="vc-bar"><Icon name="package" size={14}/><b>NC 补丁预览</b><span className="vc-sp"/><button type="button" className="vc-btn vc-btn-icon" aria-label="关闭补丁预览" onClick={onClose}><Icon name="close" size={14}/></button></div>
    <div className="vc-revision-patch-list">
      <p><b>r{entry.revision}</b> · {rows.length} 个仓库改动路径</p>
      <p className="vc-hint">清单来自此 SVN 版本。生成安装补丁需要对应源码及编译产物。</p>
      {!!mixed.length && <div className="vc-alert" data-tone="warn">{mixed.length} 个路径涉及多个需求，请核对整文件范围。</div>}
      {rows.map(row => <div className="vc-revision-patch-row" key={row.path}><span className="vc-badge">{row.action}</span><div><b>{row.path.split("/").pop()}</b><small className="vc-hint">{row.path}{row.names.length ? " · " + row.names.join("、") : ""}</small></div></div>)}
    </div>
    <div className="vc-commit-foot">
      {!!mixed.length && <label><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)}/> 已核对混改</label>}
      <button type="button" className="vc-btn vc-btn-primary" disabled={!rows.length || (!!mixed.length && !checked)} onClick={() => void copy()}>复制版本清单</button>
    </div>
  </aside>;
}
