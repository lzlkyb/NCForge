import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Icon } from "../ui/icon";
import type { MatchRange, SearchHit } from "../../lib/search";
import { setSearchForm, type SearchForm } from "../../lib/searchStore";

/**
 * 搜索结果区：汇总行 + 按文件分组的结果。
 *
 * 结果放整页而不是侧栏：侧栏放不下「路径 + 行号 + 整行代码」。
 * VS Code 用了十年侧栏，最后补了个整页 Search Editor 才解决。
 */
export function SearchResults({
  form,
  update,
  loading,
  onOpen,
}: {
  form: SearchForm;
  update: (patch: Partial<SearchForm>) => void;
  loading: boolean;
  onOpen: (hit: SearchHit) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  // 滚动位置只在挂载时恢复一次，之后由 onScroll 持续记录
  useEffect(() => {
    const el = listRef.current;
    if (el && form.scrollTop > 0) el.scrollTop = form.scrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups = useMemo(() => {
    const map = new Map<string, SearchHit[]>();
    for (const hit of form.outcome?.hits ?? []) {
      const list = map.get(hit.path);
      if (list) list.push(hit);
      else map.set(hit.path, [hit]);
    }
    return [...map.entries()];
  }, [form.outcome]);

  const toggleCollapse = (path: string) => {
    update({
      collapsed: form.collapsed.includes(path)
        ? form.collapsed.filter((p) => p !== path)
        : [...form.collapsed, path],
    });
  };

  const outcome = form.outcome;
  const collapsedCount = groups.filter(([p]) => form.collapsed.includes(p)).length;
  const allCollapsed = groups.length > 0 && collapsedCount === groups.length;

  return (
    <>
      {/* ── 汇总行 ── */}
      {outcome && (
        <div className="flex flex-shrink-0 items-center gap-2.5 border-b border-border px-4 py-1.5 text-[12px]">
          <span>
            <b>{outcome.hits.length}</b> 处 · <b>{outcome.filesMatched}</b> 个文件
          </span>
          <span className="text-muted-foreground">
            扫描 {outcome.filesScanned} 个文件 · {(outcome.elapsedMs / 1000).toFixed(1)}s
          </span>
          {outcome.truncated && (
            <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning-ink">
              到上限提前停了，结果可能不全
            </span>
          )}
          <span className="flex-1" />
          {groups.length > 0 && (
            <button
              type="button"
              onClick={() => update({ collapsed: allCollapsed ? [] : groups.map(([p]) => p) })}
              className="text-[12px] font-semibold text-primary hover:underline"
            >
              {allCollapsed ? "全部展开" : "全部折叠"}
            </button>
          )}
        </div>
      )}

      {/* ── 结果区 ── */}
      <div
        ref={listRef}
        onScroll={(e) => setSearchForm({ scrollTop: e.currentTarget.scrollTop })}
        className="min-h-0 flex-1 overflow-auto"
      >
        {!outcome && !form.error && (
          <Empty
            title={loading ? "搜索中…" : "输入关键字，回车搜索整个工作区"}
            hint={
              loading
                ? "首次要读几千个文件，冷缓存约 20 秒；同样的词再搜一次通常不到 2 秒"
                : "支持正则（.*）、整词、文件过滤；搜索词历史会留最近 10 条"
            }
          />
        )}

        {outcome && outcome.hits.length === 0 && (
          outcome.truncated ? (
            // 超时才是真问题：这时「没有找到」是假话，后面的文件根本没读。
            <Empty
              title="没搜完就到时间上限了"
              hint={`扫了 ${outcome.filesScanned} 个文件、${(outcome.elapsedMs / 1000).toFixed(1)}s 后停下，后面的文件还没看。加个文件过滤（如 *.java）能少读很多；或者直接再搜一次——文件进系统缓存后会快得多。`}
            />
          ) : (
            <Empty
              title={`没有找到 “${form.query.trim()}”`}
              hint={
                form.include.trim()
                  ? `当前有文件过滤「${form.include.trim()}」，去掉它可能就搜到了`
                  : "试试：换关键词 / 关掉「整词」/ 关掉「Aa」"
              }
            />
          )
        )}

        {groups.map(([path, hits]) => {
          const collapsed = form.collapsed.includes(path);
          const slash = path.lastIndexOf("/");
          const name = slash < 0 ? path : path.slice(slash + 1);
          const dir = slash < 0 ? "" : path.slice(0, slash);
          return (
            <div key={path} className="border-b border-border">
              <button
                type="button"
                onClick={() => toggleCollapse(path)}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-secondary/60"
              >
                <Icon
                  name="chevronDown"
                  size={13}
                  className={`flex-shrink-0 text-muted-foreground transition-transform ${
                    collapsed ? "-rotate-90" : ""
                  }`}
                />
                <Icon name="file" size={14} className="flex-shrink-0 text-primary" />
                <span className="flex-shrink-0 text-[12.5px] font-semibold">{name}</span>
                <span className="truncate text-[11px] text-muted-foreground">{dir}</span>
                <span className="ml-auto grid h-4 min-w-[18px] flex-shrink-0 place-items-center rounded-full bg-muted px-1.5 text-[10.5px] font-bold text-muted-foreground">
                  {hits.length}
                </span>
              </button>
              {!collapsed &&
                hits.map((hit) => (
                  <button
                    key={`${hit.path}:${hit.line}`}
                    type="button"
                    onClick={() => onOpen(hit)}
                    title={`${hit.path}:${hit.line}`}
                    className="grid w-full grid-cols-[46px_minmax(0,1fr)] gap-2.5 py-[3px] pl-9 pr-3 text-left hover:bg-secondary/55"
                  >
                    <span className="text-right font-mono text-[11.5px] text-muted-foreground">
                      {hit.line}
                    </span>
                    <span className="truncate font-mono text-[12px]">
                      <Highlighted text={hit.text} ranges={hit.ranges} />
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </>
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

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
      <Icon name="search" size={20} className="text-muted-foreground/60" />
      <div className="text-[13px] font-semibold">{title}</div>
      <div className="max-w-md text-[11.5px] text-muted-foreground">{hint}</div>
    </div>
  );
}
