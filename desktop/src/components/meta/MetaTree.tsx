import type { BmfDetail, BmfEntry } from "../../lib/bmf";
import type { MetaSelection } from "../../lib/metaEditor";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { MetaResourceList } from "./MetaResourceList";
import { MetaOutline } from "./MetaOutline";

/**
 * 元数据页左栏：按「来源 → 模块」分组的组件清单。
 *
 * 分组而不是平铺：同一个组件名在依赖工程和主工作区里都可能存在，
 * 平铺时用户分不清点开的是哪一份——发布前拿错文件是这里最贵的错误。
 */
export function MetaTree({
  entries,
  selected,
  search,
  onSearch,
  onSelect,
  onRefresh,
  onNew,
  refreshing,
  elapsedMs,
  cached,
  warnings,
  detail,
  selection,
  locked = false,
  onSelectObject,
}: {
  entries: BmfEntry[];
  selected: string | null;
  search: string;
  onSearch: (v: string) => void;
  onSelect: (entry: BmfEntry) => void;
  onRefresh: () => void;
  onNew: () => void;
  refreshing: boolean;
  elapsedMs: number;
  cached: number;
  warnings: string[];
  detail?: BmfDetail | null;
  selection?: MetaSelection;
  locked?: boolean;
  onSelectObject?: (selection: MetaSelection) => void;
}) {
  return (
    <aside className="meta-side">
      <div className="meta-side-head">
        <div className="flex items-center gap-2">
          <Icon name="layers" size={15} className="text-primary" />
          <span className="text-[13px] font-semibold">元数据</span>
          <span className="meta-count">{entries.length}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" title="重新索引" onClick={onRefresh} disabled={refreshing || locked}>
            <Icon name="refresh" size={14} className={refreshing ? "animate-spin" : ""} />
          </Button>
          <Button size="icon" variant="ghost" title="新建组件" onClick={onNew} disabled={locked}>
            <Icon name="filePlus" size={14} />
          </Button>
        </div>
      </div>
      <div className="meta-search">
        <Icon name="search" size={13} className="text-muted-foreground" />
        <Input
          value={search} disabled={locked}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="组件名 / 模块"
          aria-label="搜索元数据组件"
          className="h-7 border-0 bg-transparent px-1 text-[12px] focus-visible:ring-0"
        />
      </div>
      <MetaResourceList entries={entries} selected={selected} search={search} locked={locked} onSelect={onSelect} />
      {detail && selection && onSelectObject && <MetaOutline detail={detail} selection={selection} locked={locked} onSelect={onSelectObject} />}
      {warnings.length > 0 && (
        <details className="meta-warn-list">
          <summary>{warnings.length} 条索引提示</summary>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="meta-side-foot">
        {refreshing ? "正在索引…" : `${(elapsedMs / 1000).toFixed(2)}s · 缓存 ${cached}`}
      </div>
    </aside>
  );
}
