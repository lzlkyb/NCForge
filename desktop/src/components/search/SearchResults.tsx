import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import type { SearchForm } from "../../lib/searchStore";
import {
  setSearchScrollTop,
  getSearchScrollTop,
} from "../../lib/searchStore";
import { buildResultView, groupByProject, type ResultHit } from "../../lib/searchResults";
import { ResultFile } from "./ResultFile";
import { nextSearchEntry, resultHitKey, searchEntries } from "../../lib/searchNavigation";
import { SourceContextPreview } from "../workspace/SourceContextPreview";
import { SearchResultViewport } from "./SearchResultViewport";

/**
 * 搜索结果区：汇总行 + 按工程 / 文件分组的结果。
 *
 * 现在住在文件页侧栏（和 VS Code 一样窄）：每条只给「行号 + 截断的整行代码」，
 * 完整内容点开后在编辑器里看。宽度不够时汇总行换行，不做横向滚动。
 *
 * 「全部工程」结果按工程分段：同一个 `util.java` 可能同时出现在两个工程里，
 * 不标工程的话两段完全一样，点开哪个全凭猜。当前工程的结果不分段（就一个工程）。
 */
export function SearchResults({
  form,
  update,
  loading,
  onOpen,
  onEdit,
  resolvePath,
}: {
  form: SearchForm;
  update: (patch: Partial<SearchForm>) => void;
  loading: boolean;
  onOpen: (hit: ResultHit) => void;
  /** 打开「编辑匹配」轻量多缓冲；结果过期或没工作区时由调用方不传。 */
  onEdit?: () => void;
  resolvePath?: (hit: ResultHit) => string | null;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const view = useMemo(() => buildResultView(form), [form]);
  const all = form.scope === "all";

  // 滚动位置只在挂载时恢复一次，之后由 onScroll 持续记录
  useEffect(() => {
    const el = listRef.current;
    const saved = getSearchScrollTop();
    if (el && saved > 0) el.scrollTop = saved;
  }, []);

  // 换了一份结果（重新搜索 / 换范围）就回到顶部。恢复逻辑只跑一次，光把仓库里的
  // scrollTop 设成 0 不会让 DOM 自己滚回去——新结果会从上一份的偏移处开始显示。
  const identity = all ? form.projectOutcome : form.outcome;
  const [selection, setSelection] = useState<{ identity: unknown; key: string; preview: boolean } | null>(null);
  const [expandedIdentity, setExpandedIdentity] = useState<unknown>(null);
  const expanded = !!identity && expandedIdentity === identity;
  const shown = useRef<unknown>(identity);
  useEffect(() => {
    if (shown.current === identity) return;
    shown.current = identity;
    const el = listRef.current;
    if (el) el.scrollTop = 0;
  }, [identity]);

  const groups = useMemo(() => view?.groups ?? [], [view]);
  const entries = useMemo(() => searchEntries(groups), [groups]);
  const selected = selection?.identity === identity ? entries.find(entry => entry.key === selection.key) : null;
  const previewPath = selected && selection?.preview ? resolvePath?.(selected.hit) : null;
  const collapsed = new Set(form.collapsed);
  const toggleCollapse = (key: string) => {
    update({
      collapsed: collapsed.has(key)
        ? form.collapsed.filter((p) => p !== key)
        : [...form.collapsed, key],
    });
  };
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.key));
  const choose = (group: typeof groups[number], hit: ResultHit, preview = false) => {
    setSelection({ identity, key: resultHitKey(group, hit), preview });
    if (collapsed.has(group.key)) update({ collapsed: form.collapsed.filter(key => key !== group.key) });
  };
  const navigate = (direction: -1 | 1, open = false) => {
    const entry = nextSearchEntry(entries, selected?.key ?? null, direction);
    if (!entry) return;
    choose(entry.group, entry.hit, !!previewPath);
    if (open) onOpen(entry.hit);
  };
  useLayoutEffect(() => {
    if (!selected) return;
    const element = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-hit-key]") ?? [])].find(el => el.dataset.hitKey === selected.key);
    element?.scrollIntoView?.({ block: "nearest" });
  }, [selected, form.collapsed, expanded]);
  const sections = useMemo(() => (all ? groupByProject(groups) : []), [all, groups]);

  const noHits = view !== null && view.summary.hits === 0;
  const currentRoot = view?.outcomeRoot;
  // 空态文案要说清「回车会搜哪儿」：组件范围下「整个工作区」是错的
  const scopeLabel = all
    ? "全部关联工程"
    : form.scope === "component" && form.component
      ? `组件 ${form.component}`
      : "整个工作区";

  return (
    <SearchResultViewport expanded={expanded} onClose={() => setExpandedIdentity(null)}>
      {entries.length > 0 && <div className="dw-search-actions" aria-label="搜索结果导航">
        <button type="button" onClick={() => navigate(-1, true)} disabled={selected === entries[0]}>上一结果</button>
        <button type="button" onClick={() => navigate(1, true)} disabled={selected === entries[entries.length - 1]}>下一结果</button>
        <span>{selected ? `${entries.indexOf(selected) + 1} / ${entries.length}` : "↑↓ 选择 · Enter 打开"}</span>
        <button type="button" className="dw-search-expand" aria-pressed={expanded} onClick={() => setExpandedIdentity(expanded ? null : identity)}>{expanded ? "恢复侧栏" : "展开结果"}</button>
      </div>}
      {/* ── 汇总行 ── */}
      {view && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border px-3 py-1.5 text-[12px]">
          <span>
            <b>{view.summary.hits}</b> 处 · <b>{view.summary.filesMatched}</b> 个文件
            {all && view.summary.projects > 0 && <> · {view.summary.projects} 个工程</>}
          </span>
          <span className="text-muted-foreground">
            扫描 {view.summary.filesScanned} 个文件 · {(view.summary.elapsedMs / 1000).toFixed(1)}s
          </span>
          {view.summary.truncated && (
            <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning-ink">
              到上限提前停了，结果可能不全
            </span>
          )}
          <span className="flex-1" />
          {onEdit && (form.outcome?.hits.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={onEdit}
              title="把全部命中行放进一张可编辑预览，改完一次写回（仅当前工程）"
              className="text-[12px] font-semibold text-primary hover:underline"
            >
              编辑匹配
            </button>
          )}
          {groups.length > 0 && (
            <button
              type="button"
              onClick={() => update({ collapsed: allCollapsed ? [] : groups.map((g) => g.key) })}
              className="text-[12px] font-semibold text-primary hover:underline"
            >
              {allCollapsed ? "全部展开" : "全部折叠"}
            </button>
          )}
        </div>
      )}

      {/* ── 范围说明：组件目录不存在 / 回落成整个工作区 ── */}
      {view?.scopeNote && (
        <div className="flex flex-shrink-0 items-start gap-1.5 border-b border-border bg-warning/10 px-3 py-1.5 text-[11.5px] leading-relaxed">
          <Icon name="alertTriangle" size={12} className="mt-0.5 flex-shrink-0 text-warning-ink" />
          <span className="break-all text-warning-ink">{view.scopeNote}</span>
        </div>
      )}

      {/* ── 结果区 ── */}
      <div
        ref={listRef}
        tabIndex={0}
        aria-label="搜索结果列表"
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || (event.target as HTMLElement).closest("input,textarea,select")) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); navigate(event.key === "ArrowDown" ? 1 : -1); }
          else if (event.key === "Enter" && selected && (event.target === event.currentTarget || (event.target as HTMLElement).closest("[data-hit-key]"))) { event.preventDefault(); onOpen(selected.hit); }
        }}
        onScroll={(e) => setSearchScrollTop(e.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-auto"
      >
        {!view && !form.error && (
          <Empty
            title={
              loading
                ? "搜索中…"
                : all
                  ? "输入关键字，回车搜索全部关联工程"
                  : `输入关键字，回车搜索${scopeLabel}`
            }
            hint={
              loading
                ? all
                  ? "正在逐个扫描关联工程；机械盘上可能要几十秒"
                  : "首次要读几千个文件，冷缓存约 20 秒；同样的词再搜一次通常不到 2 秒"
                : all
                  ? "默认搜索当前工程与 .classpath 依赖链上的工程；替换只对「当前工程」开放"
                  : "支持正则（.*）、整词、文件过滤；搜索词历史会留最近 10 条"
            }
          />
        )}

        {view && noHits && view.summary.truncated && (
          // 超时才是真问题：这时「没有找到」是假话，后面的文件根本没读。
          <Empty
            title="没搜完就到时间上限了"
            hint={`扫了 ${view.summary.filesScanned} 个文件、${(view.summary.elapsedMs / 1000).toFixed(1)}s 后停下，后面的${all ? "工程和文件" : "文件"}还没看。${
              all ? "切到「当前工程」或" : ""
            }加个文件过滤（如 *.java）能少读很多；或者直接再搜一次——文件进系统缓存后会快得多。`}
          />
        )}

        {view && noHits && !view.summary.truncated && (
          <Empty
            title={`没有找到 “${form.query.trim()}”`}
            hint={
              all
                ? `已搜索 ${view.summary.projects} 个工程。可以切到「当前工程」缩小范围${
                    view.errors.length > 0 ? "；另有工程读取失败，命中可能没进来" : ""
                  }`
                : form.include.trim()
                  ? `当前有文件过滤「${form.include.trim()}」，去掉它可能就搜到了`
                  : "试试：换关键词 / 关掉「整词」/ 关掉「Aa」"
            }
          />
        )}

        {/* 读取失败的工程：其余工程的结果仍然有效，不能因此整页报错 */}
        {view && view.errors.length > 0 && (
          <div className="border-b border-border bg-warning/10 px-3 py-2 text-[11.5px] leading-relaxed">
            <div className="flex items-center gap-1.5 font-semibold text-warning-ink">
              <Icon name="alertTriangle" size={13} className="flex-shrink-0" />
              {view.errors.length} 个工程没搜成
            </div>
            {view.errors.map((e) => (
              <div key={e} className="break-all text-muted-foreground">
                {e}
              </div>
            ))}
          </div>
        )}

        {all &&
          sections.map((sec) => (
            <section key={sec.root} aria-label={`工程 ${sec.project}`}>
              <div className="sr-project flex items-center gap-1.5 border-b border-border bg-muted/40 px-3 py-1">
                <Icon name="folder" size={13} className="flex-shrink-0 text-muted-foreground" />
                <span className="truncate text-[12px] font-semibold">{sec.project}</span>
                {currentRoot && sec.root.toLowerCase() === currentRoot.toLowerCase() && (
                  <span className="wb-project-badge" data-current>
                    当前
                  </span>
                )}
                <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">
                  {sec.hits} 处
                </span>
              </div>
              {sec.groups.map((g) => (
                <ResultFile
                  key={g.key}
                  group={g}
                  collapsed={collapsed.has(g.key)}
                  onToggle={() => toggleCollapse(g.key)}
                  selectedKey={selected?.key}
                  onOpen={hit => { choose(g, hit); onOpen(hit); }}
                  onPreview={resolvePath ? hit => choose(g, hit, true) : undefined}
                />
              ))}
            </section>
          ))}

        {!all &&
          groups.map((g) => (
            <ResultFile
              key={g.key}
              group={g}
              collapsed={collapsed.has(g.key)}
              onToggle={() => toggleCollapse(g.key)}
              selectedKey={selected?.key}
              onOpen={hit => { choose(g, hit); onOpen(hit); }}
              onPreview={resolvePath ? hit => choose(g, hit, true) : undefined}
            />
          ))}
      </div>
      {previewPath && selected && <SourceContextPreview path={previewPath} line={selected.hit.line} identity={identity} originLabel="搜索结果" onOpen={() => onOpen(selected.hit)} onClose={() => setSelection({ identity, key: selected.key, preview: false })} />}
      {selected && selection?.preview && !previewPath && <div className="wb-panel-note" role="status">结果所属的工作区已变更，请重新搜索后预览。</div>}
    </SearchResultViewport>
  );
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
