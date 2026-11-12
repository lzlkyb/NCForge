/**
 * 「按需求审查」左栏：进行中的需求卡片、未认领、已关闭（折叠，可重新打开）。
 */
import { useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { keyOf, type ChangeItem } from "../../lib/svn";
import { changedSincePackage, type ReqGrouping } from "../../lib/reqGroups";
import { reqSetStatus, type ReqView } from "../../lib/requirements";
import type { FileBlocks } from "../../hooks/useReqBlocks";

export const UNCLAIMED_ID = "-";

/** 待审块数；取不到块的文件按文件级已审算一块。 */
export function pendingBlocks(items: readonly ChangeItem[], blocks: Map<string, FileBlocks>, reviewed: ReadonlySet<string>): { pending: number; total: number } {
  let pending = 0, total = 0;
  for (const it of items) {
    const fb = blocks.get(keyOf(it.path));
    if (fb) { total += fb.blocks.length; pending += fb.blocks.length - fb.done; }
    else { total += 1; if (!reviewed.has(keyOf(it.path))) pending += 1; }
  }
  return { pending, total };
}

export function ReqReviewSidebar({ grouping, view, selected, blocks, reviewed, onSelect }: {
  grouping: ReqGrouping; view: ReqView; selected: string | null;
  blocks: Map<string, FileBlocks>; reviewed: ReadonlySet<string>;
  onSelect: (id: string) => void;
}) {
  const [search, setSearch] = useState(""), [showClosed, setShowClosed] = useState(false);
  const q = search.trim().toLowerCase();
  const hit = (name: string, items: readonly ChangeItem[]) => !q || name.toLowerCase().includes(q) || items.some((it) => it.rel.toLowerCase().includes(q));
  const closed = view.reqs.filter((r) => r.status === "closed");
  const groups = grouping.groups.filter((g) => hit(g.req.name, g.items));
  return <aside className="vc-chg">
    <div className="vc-chg-top">
      <div className="vc-list-title"><b>需求 · {grouping.groups.length} 个进行中</b></div>
      <div className="vc-search" data-focus-container>
        <Icon name="search" size={13} /><input aria-label="搜索需求或文件" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索需求或文件" spellCheck={false} />
        {search && <button type="button" aria-label="清除搜索" onClick={() => setSearch("")}><Icon name="close" size={12} /></button>}
      </div>
    </div>
    <div className="vc-list vc-rq-list">
      {!groups.length && !grouping.unclaimed.length && <div className="vc-empty"><Icon name="check" size={24} /><div>{q ? "没有匹配的需求" : "还没有需求。AI 声明了需求名、或你新建需求后，这里会列出来。"}</div></div>}
      {groups.map((g) => {
        const { pending, total } = pendingBlocks(g.items, blocks, reviewed), since = changedSincePackage(g, view);
        return <button key={g.req.id} type="button" className="vc-rq" aria-pressed={selected === g.req.id} data-on={selected === g.req.id || undefined} onClick={() => onSelect(g.req.id)}>
          <span className="vc-rq-t" title={g.req.name}>{g.req.name}</span>
          <span className="vc-rq-m">{g.items.length} 个文件 · {pending ? `待审 ${pending} 块` : "全部审完"}
            {since !== null && <span className="vc-tag" data-tone="ship">已出包{since ? ` +${since}` : ""}</span>}
            {g.mixed.size > 0 && <span className="vc-tag" data-tone="mix">混 {g.mixed.size}</span>}
          </span>
          <span className="vc-rq-bar"><i style={{ width: `${total ? Math.round(((total - pending) / total) * 100) : 0}%` }} /></span>
        </button>;
      })}
      {grouping.unclaimed.length > 0 && hit("未认领", grouping.unclaimed) && <>
        <div className="vc-rq-sec"><span>未认领</span><span>{grouping.unclaimed.length} 个文件</span></div>
        <button type="button" className="vc-rq" aria-pressed={selected === UNCLAIMED_ID} data-on={selected === UNCLAIMED_ID || undefined} onClick={() => onSelect(UNCLAIMED_ID)}>
          <span className="vc-rq-t" data-muted>未认领的改动</span>
          <span className="vc-rq-m">{grouping.unclaimed.slice(0, 3).map((it) => it.rel.split("/").pop()).join("、")}{grouping.unclaimed.length > 3 ? " 等" : ""}</span>
        </button>
      </>}
      {closed.length > 0 && <>
        <button type="button" className="vc-rq-sec" aria-expanded={showClosed} onClick={() => setShowClosed(!showClosed)}><span><Icon name={showClosed ? "chevronDown" : "chevronRight"} size={11} /> 已关闭（{closed.length}）</span><span /></button>
        {showClosed && closed.map((r) => <div key={r.id} className="vc-rq vc-rq-closed">
          <span className="vc-rq-t" title={r.name}>{r.name}</span>
          <button type="button" className="vc-btn vc-btn-sm" onClick={() => void reqSetStatus(r.id, true).catch((e) => toast(`重新打开失败：${String(e)}`, "error"))}>重新打开</button>
        </div>)}
      </>}
    </div>
  </aside>;
}
