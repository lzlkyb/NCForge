import { type ReactNode } from "react";
import { Icon } from "../ui/icon";
import type { MatchRange } from "../../lib/search";
import type { ResultFileGroup, ResultHit } from "../../lib/searchResults";
import { buildSearchPreview } from "../../lib/searchPreview";
import { resultHitKey } from "../../lib/searchNavigation";

/** 一个文件的命中组（标题行 + 逐行命中）。当前范围与全部工程共用。 */
export function ResultFile({
  group,
  collapsed,
  onToggle,
  onOpen,
  selectedKey,
  onPreview,
}: {
  group: ResultFileGroup;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (hit: ResultHit) => void;
  selectedKey?: string | null;
  onPreview?: (hit: ResultHit) => void;
}) {
  const { path, hits } = group;
  const slash = path.lastIndexOf("/");
  const name = slash < 0 ? path : path.slice(slash + 1);
  const dir = slash < 0 ? "" : path.slice(0, slash);
  // 同名路径在不同工程里是不同文件，title 里要能看到是哪个工程的哪一个
  const abs = group.projectRoot ? `${group.projectRoot}\\${path.replace(/\//g, "\\")}` : path;

  return (
    <div className="sr-group border-b border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={abs}
        className="flex w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-left hover:bg-secondary/60"
      >
        <Icon
          name="chevronDown"
          size={13}
          className={`flex-shrink-0 text-muted-foreground transition-transform ${
            collapsed ? "-rotate-90" : ""
          }`}
        />
        <Icon name="file" size={14} className="flex-shrink-0 text-primary" />
        <span className="min-w-0 truncate text-[12.5px] font-semibold">{name}</span>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">{dir}</span>
        <span className="ml-auto grid h-4 min-w-[18px] flex-shrink-0 place-items-center rounded-full bg-muted px-1.5 text-[10.5px] font-bold text-muted-foreground">
          {hits.length}
        </span>
      </button>
      {!collapsed &&
        hits.map((hit) => {
          const preview = buildSearchPreview(hit.text, hit.ranges);
          return (
            <div key={resultHitKey(group, hit)} className="dw-search-hit-wrap">
            <button
              key={`${group.key}:${hit.line}`}
              type="button"
              onClick={() => onOpen(hit)}
              title={`${abs}:${hit.line}\n${hit.text}`}
              data-hit-key={resultHitKey(group, hit)}
              data-selected={selectedKey === resultHitKey(group, hit) || undefined}
              className="dw-search-hit grid w-full grid-cols-[36px_minmax(0,1fr)] gap-x-2 py-[3px] px-3 text-left hover:bg-secondary/55"
            >
              <span className="text-right font-mono text-[11.5px] text-muted-foreground">
                {hit.line}
              </span>
              <span className="truncate font-mono text-[12px]">
                <Highlighted text={preview.text} ranges={preview.ranges} />
              </span>
              {preview.ranges.length === 0 && (
                <span className="col-start-2 text-[11px] text-muted-foreground">
                  预览未包含匹配位置，打开完整行查看
                </span>
              )}
            </button>
            {onPreview && <button type="button" className="wb-icon-btn dw-preview-button" aria-label={`预览 ${name} 第 ${hit.line} 行上下文`} title="预览上下文" onClick={() => onPreview(hit)}><Icon name="eye" size={13} /></button>}
            </div>
          );
        })}
    </div>
  );
}

/**
 * 按后端给的区间画 `<mark>`。
 *
 * 区间是 UTF-16 偏移，直接就是 JS 字符串下标，**不要**再自己 `indexOf`——正则模式下
 * 前端算不出命中位置。区间可能超出截断后的文本长度（后端已裁掉大部分），这里再夹一次
 * 是防线。
 */
function Highlighted({ text, ranges }: { text: string; ranges: MatchRange[] }) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach((r, i) => {
    const start = Math.max(at, Math.min(r.start, text.length));
    const end = Math.max(start, Math.min(r.end, text.length));
    if (start > at) parts.push(<span key={`t${i}`}>{text.slice(at, start)}</span>);
    if (end > start) {
      parts.push(
        <mark key={`m${i}`} className="rounded-sm bg-warning/30 text-inherit">
          {text.slice(start, end)}
        </mark>,
      );
    }
    at = end;
  });
  if (at < text.length) parts.push(<span key="tail">{text.slice(at)}</span>);
  return <>{parts}</>;
}
