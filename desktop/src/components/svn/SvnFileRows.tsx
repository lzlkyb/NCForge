import { Icon } from "../ui/icon";
import { SvnCheckbox } from "./SvnCheckbox";
import { formatWhen, keyOf, letterTone, type ChangeGroup, type ChangeItem, type SortMode } from "../../lib/svn";
import { isSvnCommittable, isSvnPicked, selectSvnPaths, toggleSvnPicked } from "../../lib/svnDraft";
export function SvnFileRows({ group, closed, onToggleGroup, selected, reviewed, picked, root, busy, sort, onSelect, onOpenFile }: { group: ChangeGroup; closed: boolean; onToggleGroup: () => void; selected: string | null; reviewed: ReadonlySet<string>; picked: ReadonlySet<string>; root: string; busy: boolean; sort: SortMode; onSelect: (item: ChangeItem) => void; onOpenFile?: (path: string) => void }) {
  const eligible = group.items.filter(isSvnCommittable);
  const count = eligible.filter(it => isSvnPicked(picked,it.path)).length;
  const toggleGroup = () => {
    const keys = new Set(eligible.map(it => keyOf(it.path)));
    const paths = count === eligible.length
      ? [...picked].filter(path => !keys.has(keyOf(path)))
      : [...picked,...eligible.map(it => it.path)];
    selectSvnPaths(root,paths);
  };
  return <div className="vc-file-group">
    <div className="vc-group-head">
      <SvnCheckbox label={`选择模块 ${group.module}`} checked={eligible.length > 0 && count === eligible.length} mixed={count > 0 && count < eligible.length} disabled={busy || !eligible.length} onChange={toggleGroup} />
      <button type="button" className="vc-grp" data-closed={closed || undefined} aria-expanded={!closed} onClick={onToggleGroup}><Icon name="chevronDown" size={12} /><span className="vc-grp-name" title={group.module}>{group.module}</span><span className="n">{group.items.length}</span></button>
    </div>
    {!closed && group.items.map(it => {
      const done = reviewed.has(keyOf(it.path)), name = it.rel.split("/").pop() ?? it.rel;
      const dir = it.rel.slice(0,Math.max(0,it.rel.lastIndexOf("/")));
      return <div className="vc-file-row" key={it.path} data-selected={selected !== null && keyOf(selected) === keyOf(it.path) || undefined}>
        <SvnCheckbox label={`提交 ${it.rel}`} checked={isSvnPicked(picked,it.path)} disabled={busy || !isSvnCommittable(it)} onChange={() => toggleSvnPicked(root,it.path)} />
        <button type="button" className="vc-row" data-file-row aria-pressed={selected !== null && keyOf(selected) === keyOf(it.path)} data-reviewed={done || undefined} title={it.rel} onClick={() => onSelect(it)} onDoubleClick={() => !it.isDir && onOpenFile?.(it.path)} onKeyDown={e => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === " ") { e.preventDefault(); if (!busy && isSvnCommittable(it)) toggleSvnPicked(root,it.path); return; }
          if (!["ArrowDown","ArrowUp","Home","End"].includes(e.key)) return;
          e.preventDefault();
          const rows = [...e.currentTarget.closest(".vc-list")!.querySelectorAll<HTMLButtonElement>("[data-file-row]")];
          const index = rows.indexOf(e.currentTarget), target = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.max(0,Math.min(rows.length - 1,index + (e.key === "ArrowDown" ? 1 : -1)));
          rows[target]?.focus(); rows[target]?.click();
        }}>
          <span className="vc-badge" data-st={letterTone(it.letter)}>{it.letter}</span>
          <span className="vc-file-label"><span className="vc-fn">{name}</span>{dir && <span className="vc-file-dir">{dir}</span>}</span>
          {done && <span className="vc-reviewed-mark" title="已审查" aria-label="已审查"><Icon name="check" size={12} /></span>}
          {sort === "mtime" && <span className="vc-when">{formatWhen(it.mtimeMs)}</span>}
        </button>
      </div>;
    })}
  </div>;
}
