import { baseName } from "../../lib/workspace";
import { useOperations } from "../../lib/operations";
import { setPackageView, toggleRevealOnOpen, usePackageView, useRevealOnOpen } from "../../lib/treeViewPrefs";
import { TreeViewOptions } from "./TreeViewOptions";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import { treeFilterFor, useTreeFilter } from "../../lib/treeFilter";
import "../../reading-tools.css";

/**
 * 树只保留视图、定位、名称过滤和新建；工程切换与全文搜索使用顶栏统一入口。
 */
export function TreeHeader({
  root,
  projectCount = 1,
  onCreateFile,
  onCreateDir,
}: {
  root: string;
  /** 关联工程数（含当前）。>1 时在标题下说清「编译 / SVN 只作用于当前」 */
  projectCount?: number;
  onCreateFile: () => void;
  onCreateDir: () => void;
}) {
  const packageView = usePackageView();
  const reveal = useRevealOnOpen();
  const tasks = useOperations();
  const switching = tasks.some((o) => o.key === "workspace.switch" && !o.endedAt);
  const filter = useTreeFilter(root);

  return (
    <>
      <div className="wb-pane-title wb-code-tree-title">
        <div className="wb-code-tree-heading">
          <span className="wb-code-tree-name" title={root}>
            <span className="wb-code-tree-full">{packageView ? "包资源管理器" : "资源管理器"}</span>
            <span className="wb-code-tree-short">资源</span>
          </span>
          <div className="wb-tree-view-switch" role="group" aria-label="资源树视图">
            <button type="button" aria-label="文件视图" aria-pressed={!packageView} onClick={() => setPackageView(false)}>文件</button>
            <button type="button" aria-label="包视图" aria-pressed={packageView} onClick={() => setPackageView(true)}>包</button>
          </div>
        </div>
        <div className="wb-pane-acts">
          <button type="button" className="wb-icon-btn" aria-label="自动定位" aria-pressed={reveal}
            title={`自动定位${reveal ? "已开启，点击关闭" : "已关闭，点击开启"}：打开文件时在资源树中展开并定位；手动定位不受影响`}
            onClick={toggleRevealOnOpen}><Icon name="target" size={16} /></button>
          <button type="button" className="wb-icon-btn" aria-label="过滤资源树入口" title="过滤文件名和包名" aria-expanded={filter.open} aria-pressed={!!filter.text}
            onClick={() => treeFilterFor(root).set({ open: !filter.open, ...(!filter.open ? {} : { text: "" }) })}><Icon name="filter" size={16} /></button>
          <Menu portal width="w-72" trigger={(open, toggle) => <button type="button" className="wb-icon-btn" aria-label="更多资源操作" title="资源树设置与新建" disabled={switching} aria-haspopup="menu" aria-expanded={open} onClick={toggle}><Icon name="more" size={16} /></button>}>
            {close => <>
              <MenuItem label="新建文件" icon="filePlus" onClick={() => { close(); onCreateFile(); }} />
              <MenuItem label="新建文件夹" icon="folderPlus" onClick={() => { close(); onCreateDir(); }} />
              <div className="wb-menu-separator" role="separator" />
              <p className="wb-menu-caption">视图设置</p>
              <TreeViewOptions root={root} onClose={close} />
            </>}
          </Menu>
        </div>
      </div>
      {projectCount > 1 && (
        <div className="wb-tree-scope">
          当前 <b>{baseName(root) || root}</b> · 编译 / SVN 只作用于它 · 共 {projectCount} 个关联工程
        </div>
      )}
    </>
  );
}
