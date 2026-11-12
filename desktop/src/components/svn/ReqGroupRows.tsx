/**
 * 变更列表「按需求」分组（按需求审查 P1 · 方案一）。
 *
 * 文件行复用 SvnFileRows（勾选提交、键盘导航、双击打开都照旧），这里只管分组、组头菜单和行内标记：
 * 「x/y 块」、「混」（也被别的需求改过）、未认领文件的来源。
 */
import { useMemo } from "react";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import { SvnFileRows } from "./SvnFileRows";
import { keyOf, type ChangeItem, type SortMode } from "../../lib/svn";
import { changedSincePackage, FILE_SOURCE_LABEL, fileSource, groupByRequirement, reqName } from "../../lib/reqGroups";
import { claimFiles, closeRequirement, copyFileList, mergeRequirement, packRequirement, renameRequirement } from "../../lib/reqActions";
import type { ReqView, Requirement } from "../../lib/requirements";
import { isSvnPicked } from "../../lib/svnDraft";
import { setSvnListPrefs } from "../../lib/svnListPrefs";
import { useReqBlocks, type FileBlocks } from "../../hooks/useReqBlocks";

export const reqGroupKey = (id: string) => `req:${id}`;
export const UNCLAIMED_KEY = "req:-";

interface Props {
  items: ChangeItem[];
  reqs: ReqView;
  root: string;
  closed: string[];
  selected: string | null;
  tabStop?: string;
  reviewed: ReadonlySet<string>;
  outdated?: ReadonlySet<string>;
  picked: ReadonlySet<string>;
  busy: boolean;
  sort: SortMode;
  onSelect: (item: ChangeItem) => void;
  onOpenFile?: (path: string) => void;
  /** 「本需求全部标为已审」：由 SvnReview 提供（要同时写文件级标记）。 */
  onMarkAll?: (items: ChangeItem[], blocks: Map<string, FileBlocks>) => void;
}

function BlockProgress({ fb, done }: { fb?: FileBlocks; done: boolean }) {
  if (!fb) return done ? <span className="vc-reviewed-mark" title="已审查" aria-label="已审查"><Icon name="check" size={12} /></span> : null;
  const all = fb.blocks.length > 0 && fb.done === fb.blocks.length;
  return <span className="vc-blocks" data-state={all ? "done" : fb.done ? "part" : undefined} title={`已审 ${fb.done} 块 / 共 ${fb.blocks.length} 块`}>{all && <Icon name="check" size={11} />}{fb.done}/{fb.blocks.length} 块</span>;
}

export function ReqGroupRows(p: Props) {
  const { groups, unclaimed } = useMemo(() => groupByRequirement(p.items, p.reqs), [p.items, p.reqs]);
  const grouped = useMemo(() => [...new Map(groups.flatMap((g) => g.items).map((it) => [keyOf(it.path), it])).values()], [groups]);
  const blocks = useReqBlocks(p.root, grouped);
  const open = p.reqs.reqs.filter((r) => r.status === "open");
  const toggle = (key: string) => setSvnListPrefs(p.root, { closed: p.closed.includes(key) ? p.closed.filter((s) => s !== key) : [...p.closed, key] });
  const common = { selected: p.selected, tabStop: p.tabStop, reviewed: p.reviewed, outdated: p.outdated, picked: p.picked, root: p.root, busy: p.busy, sort: p.sort, onSelect: p.onSelect, onOpenFile: p.onOpenFile };
  const menuTrigger = (label: string) => (isOpen: boolean, flip: () => void) => <button type="button" className="vc-btn vc-btn-sm vc-grp-more" aria-label={label} aria-haspopup="menu" aria-expanded={isOpen} onClick={flip}><Icon name="more" size={13} /></button>;
  const reqMenu = (req: Requirement, items: ChangeItem[]) => <Menu portal width="w-56" trigger={menuTrigger(`需求操作 ${req.name}`)}>
    {close => <>
      <MenuItem label="用这个需求出包…" hint="带入打包页" onClick={() => { close(); packRequirement(p.root, req, items); }} />
      <MenuItem label="改名…" hint="如补上清单号" onClick={() => { close(); void renameRequirement(req); }} />
      {req.mergeHint && <MenuItem label={`并入「${reqName(p.reqs, req.mergeHint)}」`} hint="名字很像" onClick={() => { close(); if (req.mergeHint) void mergeRequirement(req, req.mergeHint); }} />}
      {p.onMarkAll && <MenuItem label="本需求全部标为已审" onClick={() => { close(); p.onMarkAll?.(items, blocks); }} />}
      <MenuItem label="复制文件清单" onClick={() => { close(); void copyFileList(items); }} />
      <MenuItem label="关闭需求" hint="文件回到未认领" onClick={() => { close(); void closeRequirement(req); }} />
    </>}
  </Menu>;
  // 未认领：勾了提交框的就只归勾了的，一个没勾就归全部（菜单里写明个数）。
  const pickedUnclaimed = unclaimed.filter((it) => isSvnPicked(p.picked, it.path));
  const claimTargets = pickedUnclaimed.length ? pickedUnclaimed : unclaimed;
  const claimMenu = <Menu portal width="w-64" trigger={menuTrigger("归入需求")}>
    {close => <>
      <MenuItem label={`${pickedUnclaimed.length ? `把勾选的 ${claimTargets.length} 个` : `把全部 ${claimTargets.length} 个`}归入：`} disabled onClick={() => undefined} />
      {open.map((r) => <MenuItem key={r.id} label={r.name} onClick={() => { close(); void claimFiles(claimTargets.map((it) => it.path), r.id); }} />)}
      <MenuItem label="＋ 新建需求…" onClick={() => { close(); void claimFiles(claimTargets.map((it) => it.path), "new"); }} />
    </>}
  </Menu>;
  return <>
    {groups.map((g) => {
      const key = reqGroupKey(g.req.id), since = changedSincePackage(g, p.reqs);
      return <SvnFileRows key={key} {...common} group={{ module: key, items: g.items }} title={g.req.name} closed={p.closed.includes(key)} onToggleGroup={() => toggle(key)}
        headExtra={since !== null ? <span className="vc-tag" data-tone="ship" title={since ? `出过包，之后又改了 ${since} 个文件` : "出过包，之后没有新改动"}>已出包{since ? ` +${since}` : ""}</span> : undefined}
        headAction={reqMenu(g.req, g.items)}
        rowExtra={(it) => {
          const others = g.mixed.get(keyOf(it.path));
          return <>{others && <span className="vc-tag" data-tone="mix" title={`这个文件也被「${others.map((id) => reqName(p.reqs, id)).join("」「")}」改过`}>混</span>}<BlockProgress fb={blocks.get(keyOf(it.path))} done={p.reviewed.has(keyOf(it.path))} /></>;
        }} />;
    })}
    {unclaimed.length > 0 && <SvnFileRows {...common} group={{ module: UNCLAIMED_KEY, items: unclaimed }} title="未认领" muted closed={p.closed.includes(UNCLAIMED_KEY)} onToggleGroup={() => toggle(UNCLAIMED_KEY)}
      headAction={claimMenu}
      rowExtra={(it) => {
        const src = fileSource(p.reqs, it.path);
        return <><span className="vc-tag" data-tone="muted" title={src === "unknown" ? "没有变更日志记录：可能是命令、其他编辑器或 SVN 外部改的" : undefined}>{FILE_SOURCE_LABEL[src]}</span>{p.reviewed.has(keyOf(it.path)) && <BlockProgress done />}</>;
      }} />}
  </>;
}
