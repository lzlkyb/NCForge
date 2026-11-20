import { memo, type ReactNode } from "react";
import { Icon } from "../ui/icon";
import { SvnCheckbox } from "./SvnCheckbox";
import { formatWhen, keyOf, letterTone, svnStatusLabel, type ChangeGroup, type ChangeItem, type SortMode } from "../../lib/svn";
import { isSvnCommittable, isSvnPicked, selectSvnPaths, toggleSvnPicked } from "../../lib/svnDraft";

interface RowProps {
  it: ChangeItem;
  isSelected: boolean;
  isTabStop: boolean;
  done: boolean;
  isOutdated: boolean;
  isPicked: boolean;
  committable: boolean;
  busy: boolean;
  sort: SortMode;
  root: string;
  onSelect: (item: ChangeItem) => void;
  onOpenFile?: (path: string) => void;
  rowExtra?: (it: ChangeItem) => ReactNode;
}

/**
 * 单行 memo：选中 / 勾选变化时组组件会重渲（items 数组每次新建），但落到每行的
 * 只是布尔量——按值比较后只有真正变化的两行重建 JSX，几千行不再整列表 diff。
 * it 的引用每次分组重算都变，所以比较器逐字段比，不比引用。
 */
const SvnFileRow = memo(function SvnFileRow({ it, isSelected, isTabStop, done, isOutdated, isPicked, committable, busy, sort, root, onSelect, onOpenFile, rowExtra }: RowProps) {
  const name = it.rel.split("/").pop() ?? it.rel;
  const dir = it.rel.slice(0, Math.max(0, it.rel.lastIndexOf("/")));
  return <div className="vc-file-row" data-selected={isSelected || undefined}>
    <SvnCheckbox tabIndex={-1} label={`提交 ${it.rel}`} checked={isPicked} disabled={busy || !committable} onChange={() => toggleSvnPicked(root, it.path)} />
    <button type="button" className="vc-row" data-file-row tabIndex={isTabStop ? 0 : -1} aria-keyshortcuts="Space Control+Enter Meta+Enter" aria-description={isPicked ? "已选提交，空格取消选择" : "空格选中提交"} aria-pressed={isSelected} data-reviewed={done || undefined} title={it.rel} onClick={() => onSelect(it)} onDoubleClick={() => !it.isDir && onOpenFile?.(it.path)} onKeyDown={e => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !it.isDir && onOpenFile) { e.preventDefault(); onOpenFile(it.path); return; }
      if (e.key === " ") { e.preventDefault(); if (!busy && committable) toggleSvnPicked(root, it.path); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const rows = [...(e.currentTarget.closest(".vc-list")?.querySelectorAll<HTMLButtonElement>("[data-file-row]") ?? [])];
      const index = rows.indexOf(e.currentTarget), target = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)));
      rows[target]?.focus(); rows[target]?.click();
    }}>
      <span className="vc-file-label">
        <span className="vc-file-line">
          <span className="vc-fn">{name}</span>
          {rowExtra?.(it)}
          {!done && isOutdated && <span className="vc-commit-review" data-outdated>需重审</span>}
          {done && !rowExtra && <span className="vc-reviewed-mark" title="已审查" aria-label="已审查"><Icon name="check" size={12} /></span>}
          <span className="vc-badge vc-badge-label" data-st={letterTone(it.letter)} title={`SVN ${it.letter} · ${svnStatusLabel[it.letter]}`}>{svnStatusLabel[it.letter]}</span>
        </span>
        {(dir || sort === "mtime") && <span className="vc-file-line">
          <span className="vc-file-dir">{dir}</span>
          {sort === "mtime" && <span className="vc-when">{formatWhen(it.mtimeMs)}</span>}
        </span>}
      </span>
    </button>
  </div>;
}, (a, b) =>
  a.it.path === b.it.path && a.it.rel === b.it.rel && a.it.letter === b.it.letter && a.it.mtimeMs === b.it.mtimeMs && a.it.isDir === b.it.isDir &&
  a.isSelected === b.isSelected && a.isTabStop === b.isTabStop && a.done === b.done && a.isOutdated === b.isOutdated && a.isPicked === b.isPicked &&
  a.committable === b.committable && a.busy === b.busy && a.sort === b.sort && a.root === b.root &&
  a.onSelect === b.onSelect && a.onOpenFile === b.onOpenFile && a.rowExtra === b.rowExtra);

/**
 * 一个分组（模块或需求）的组头 + 文件行。按需求分组时由 ReqGroupRows 传入：
 * `title` 替换组名、`headExtra` 放标签（在折叠按钮内）、`headAction` 放「⋯」菜单（按钮外，按钮不能套按钮）、`rowExtra` 在文件名后插块数/混改等标记。
 */
export function SvnFileRows({ group, closed, onToggleGroup, selected, tabStop, reviewed, outdated, picked, root, busy, sort, onSelect, onOpenFile, title, muted, headExtra, headAction, rowExtra }: { group: ChangeGroup; closed: boolean; onToggleGroup: () => void; selected: string | null; tabStop?: string; reviewed: ReadonlySet<string>; outdated?: ReadonlySet<string>; picked: ReadonlySet<string>; root: string; busy: boolean; sort: SortMode; onSelect: (item: ChangeItem) => void; onOpenFile?: (path: string) => void; title?: string; muted?: boolean; headExtra?: ReactNode; headAction?: ReactNode; rowExtra?: (it: ChangeItem) => ReactNode }) {
  const label = title ?? group.module;
  const eligible = group.items.filter(isSvnCommittable);
  const count = eligible.filter(it => isSvnPicked(picked,it.path)).length;
  const selKey = selected !== null ? keyOf(selected) : null;
  const toggleGroup = () => {
    const keys = new Set(eligible.map(it => keyOf(it.path)));
    const paths = count === eligible.length
      ? [...picked].filter(path => !keys.has(keyOf(path)))
      : [...picked,...eligible.map(it => it.path)];
    selectSvnPaths(root,paths);
  };
  return <div className="vc-file-group">
    <div className="vc-group-head">
      <SvnCheckbox label={`选择${title ? "需求" : "模块"} ${label}`} checked={eligible.length > 0 && count === eligible.length} mixed={count > 0 && count < eligible.length} disabled={busy || !eligible.length} onChange={toggleGroup} />
      <button type="button" className="vc-grp" data-closed={closed || undefined} aria-expanded={!closed} onClick={onToggleGroup}><Icon name="chevronDown" size={12} /><span className="vc-grp-name" data-muted={muted || undefined} title={label}>{label}</span>{headExtra && <span className="vc-grp-tags">{headExtra}</span>}<span className="n">{group.items.length}</span></button>
      {headAction}
    </div>
    {!closed && group.items.map(it => {
      const k = keyOf(it.path);
      return <SvnFileRow key={it.path} it={it}
        isSelected={selKey !== null && selKey === k}
        isTabStop={tabStop === undefined || it.path === tabStop}
        done={reviewed.has(k)} isOutdated={!!outdated?.has(k)} isPicked={isSvnPicked(picked, it.path)}
        committable={isSvnCommittable(it)} busy={busy} sort={sort} root={root}
        onSelect={onSelect} onOpenFile={onOpenFile} rowExtra={rowExtra} />;
    })}
  </div>;
}
