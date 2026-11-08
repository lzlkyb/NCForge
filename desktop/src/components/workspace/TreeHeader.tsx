import { useRef, useState } from "react";
import { pickFolder, pickFolderError } from "../../lib/folderPicker";
import { baseName } from "../../lib/workspace";
import { useOperations } from "../../lib/operations";
import { setPackageView, toggleRevealOnOpen, usePackageView, useRevealOnOpen } from "../../lib/treeViewPrefs";
import { TreeViewOptions } from "./TreeViewOptions";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import { treeFilterFor, useTreeFilter } from "../../lib/treeFilter";
import "../../reading-tools.css";

/**
 * 左栏顶部保留视图切换、自动定位、名称过滤和搜索；低频设置与工程操作合并到菜单。
 *
 * 换目录走系统文件夹选择器：手打路径的斜杠方向、大小写、目录不存在都会失败，
 * 而选择器至少保证选中的是一个真实存在的文件夹。最近工作区仍保留一键切换。
 */
export function TreeHeader({
  root,
  projectCount = 1,
  recents,
  onOpen,
  onOpenRecent,
  onCreateFile,
  onCreateDir,
  onSearch,
}: {
  root: string;
  /** 关联工程数（含当前）。>1 时在标题下说清「编译 / SVN 只作用于当前」 */
  projectCount?: number;
  /** 最近工作区（换目录时直接点，不用再走选择器）。 */
  recents: string[];
  onOpen: (path: string) => void;
  onOpenRecent: (path: string) => void;
  onCreateFile: () => void;
  onCreateDir: () => void;
  /** 切到全工程搜索（侧栏视图，不再占主导航页签）。 */
  onSearch: () => void;
}) {
  const packageView = usePackageView();
  const reveal = useRevealOnOpen();
  const tasks = useOperations();
  const switching = tasks.some((o) => o.key === "workspace.switch" && !o.endedAt);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const filter = useTreeFilter(root);
  const picking = useRef(false);

  const choose = async () => {
    if (picking.current || switching) return;
    picking.current = true;
    setChoosing(true);
    setError(null);
    try {
      const path = await pickFolder({ title: "更换工作区目录", defaultPath: root });
      // 取消选择保持原目录，不弹错误。
      if (path) onOpen(path);
    } catch (e) {
      setError(pickFolderError(e));
    } finally {
      picking.current = false;
      setChoosing(false);
    }
  };

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
          <button
            type="button"
            className="wb-icon-btn"
            title="全工程搜索（Ctrl+K）"
            aria-label="全工程搜索"
            onClick={onSearch}
          >
            <Icon name="search" size={16} />
          </button>
          <Menu portal width="w-72" trigger={(open, toggle) => <button type="button" className="wb-icon-btn" aria-label="更多资源操作" title="资源树设置、新建与工程操作" disabled={switching || choosing} aria-haspopup="menu" aria-expanded={open} onClick={toggle}><Icon name={choosing ? "spinner" : "more"} className={choosing ? "animate-spin" : undefined} size={16} /></button>}>
            {close => <>
              <MenuItem label="新建文件" icon="filePlus" onClick={() => { close(); onCreateFile(); }} />
              <MenuItem label="新建文件夹" icon="folderPlus" onClick={() => { close(); onCreateDir(); }} />
              <MenuItem label="更换工作区目录" icon="folder" onClick={() => { close(); void choose(); }} />
              <div className="wb-menu-separator" role="separator" />
              <p className="wb-menu-caption">视图设置</p>
              <TreeViewOptions root={root} onClose={close} />
              {recents.length > 0 && <p className="wb-tree-menu-note">最近工程</p>}
              {recents.map(path => <MenuItem key={path} label={<span title={path}>{baseName(path)}</span>} hint={path === root ? "当前" : undefined} onClick={() => { close(); onOpenRecent(path); }} />)}
            </>}
          </Menu>
        </div>
      </div>
      {projectCount > 1 && (
        <div className="wb-tree-scope">
          当前 <b>{baseName(root) || root}</b> · 编译 / SVN 只作用于它 · 共 {projectCount} 个关联工程
        </div>
      )}
      {error && (
        <div className="wb-row-note" data-tone="bad" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
