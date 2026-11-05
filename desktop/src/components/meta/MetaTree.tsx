import { useMemo } from "react";
import type { BmfEntry } from "../../lib/bmf";
import { normalizeBmfPath } from "../../lib/bmfPath";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";

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
}) {
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const hit = entries.filter(
      (e) =>
        !q ||
        e.name.toLowerCase().includes(q) ||
        e.displayName.toLowerCase().includes(q) ||
        e.module.toLowerCase().includes(q),
    );
    const map = new Map<string, BmfEntry[]>();
    for (const e of hit) {
      const key = `${e.origin}/${e.module || "(未知模块)"}`;
      const list = map.get(key) ?? [];
      list.push(e);
      map.set(key, list);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, list]) => ({
        key,
        list: list.sort((a, b) => a.name.localeCompare(b.name)),
      }));
  }, [entries, search]);

  return (
    <aside className="meta-side">
      <div className="meta-side-head">
        <div className="flex items-center gap-2">
          <Icon name="layers" size={15} className="text-primary" />
          <span className="text-[13px] font-semibold">元数据</span>
          <span className="meta-count">{entries.length}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" title="重新索引" onClick={onRefresh} disabled={refreshing}>
            <Icon name="refresh" size={14} className={refreshing ? "animate-spin" : ""} />
          </Button>
          <Button size="icon" variant="ghost" title="新建组件" onClick={onNew}>
            <Icon name="filePlus" size={14} />
          </Button>
        </div>
      </div>
      <div className="meta-search">
        <Icon name="search" size={13} className="text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="组件名 / 模块"
          aria-label="搜索元数据组件"
          className="h-7 border-0 bg-transparent px-1 text-[12px] focus-visible:ring-0"
        />
      </div>
      <div className="meta-tree">
        {groups.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">
            {entries.length === 0 ? "工作区里没有找到 .bmf 文件" : "没有匹配的组件"}
          </p>
        )}
        {groups.map((g) => (
          <div key={g.key} className="meta-group">
            <div className="meta-group-head" title={g.key}>
              {g.key}
            </div>
            {g.list.map((e) => (
              <button
                key={e.path}
                type="button"
                className={`meta-entry ${selected && normalizeBmfPath(selected) === normalizeBmfPath(e.path) ? "is-active" : ""} ${e.error ? "is-broken" : ""}`}
                aria-current={selected && normalizeBmfPath(selected) === normalizeBmfPath(e.path) ? "true" : undefined}
                onClick={() => onSelect(e)}
                title={e.error ? `${e.path}\n${e.error}` : e.path}
              >
                <span className="meta-entry-name">{e.name || "(无名)"}</span>
                <span className="meta-entry-sub">
                  {e.displayName || "—"}
                  {e.error ? " · 解析失败" : ` · ${e.entityCount} 实体 / ${e.attrCount} 字段`}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
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
