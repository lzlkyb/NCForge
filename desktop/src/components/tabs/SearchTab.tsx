import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { searchWorkspace, type MatchRange, type SearchHit } from "../../lib/search";
import { getWorkspace, joinPath } from "../../lib/workspace";
import { getSearchForm, loadHistory, pushHistory, setSearchForm, type SearchForm } from "../../lib/searchStore";

/** 文件过滤的常用预设：NC 工程的代码在 .java，配置与单据模板在 .xml / .properties。 */
const MASK_PRESETS = ["*.java", "*.xml", "*.properties"];

/**
 * 全工程搜索页（M2）。
 *
 * 交互取舍（都照成熟工具的实际做法定的，理由见各处注释）：
 * - **不边输边搜**：后端是真实扫盘（7000 文件约 0.6s），边输边搜会把磁盘打满、
 *   结果还一直跳。回车或按「搜索」才真正执行——Eclipse 的 Ctrl+H 也是这个模型。
 * - **结果放整页**：侧栏那种窄面板放不下「路径 + 行号 + 整行代码」。VS Code 用了
 *   十年侧栏，最后补了个整页 Search Editor 才解决；我们本来就有页面位。
 * - **选项常显**：整页横向空间够，不学 VS Code 把过滤收进「⋯」——收纳后不给快捷键
 *   基本想不起来。
 * - **点命中去 Files 页并定位行**，靠 lib/openFileRequest 这条单向管道。
 */
export function SearchTab({ onOpenFile }: { onOpenFile: (path: string, line: number) => void }) {
  // 从模块仓库初始化：切走再回来，结果、折叠、滚动位置都还在
  const [form, setForm] = useState<SearchForm>(getSearchForm);
  const [root, setRoot] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [loading, setLoading] = useState(false);
  // 每次搜索自增：慢请求回来时如果已有更新的请求，结果直接丢掉
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const update = useCallback((patch: Partial<SearchForm>) => {
    setForm((f) => {
      const next = { ...f, ...patch };
      setSearchForm(next);
      return next;
    });
  }, []);

  useEffect(() => {
    getWorkspace()
      .then(setRoot)
      .catch(() => setRoot(null));
  }, []);

  // 滚动位置只在挂载时恢复一次，之后由 onScroll 持续记录
  useEffect(() => {
    const el = listRef.current;
    if (el && form.scrollTop > 0) el.scrollTop = form.scrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async () => {
    const q = form.query.trim();
    if (!q || loading) return;
    const mine = ++seq.current;
    setLoading(true);
    update({ error: null });
    try {
      const outcome = await searchWorkspace({
        // 正则模式按原样传（前后空格有意义），纯文本模式传 trim 过的
        text: form.regex ? form.query : q,
        caseSensitive: form.caseSensitive,
        // 正则开着时「整词」不生效（后端也忽略）：想整词自己写 \b，与 IDEA 一致
        wholeWord: form.regex ? false : form.wholeWord,
        regex: form.regex,
        include: form.include.trim(),
      });
      if (mine !== seq.current) return;
      setHistory(pushHistory(q));
      update({ outcome, collapsed: [], scrollTop: 0 });
      if (listRef.current) listRef.current.scrollTop = 0;
    } catch (e) {
      if (mine !== seq.current) return;
      // 正则语法错之类：清掉旧结果，否则「报错了但结果还在」会让人以为搜成功了
      update({ outcome: null, error: String(e) });
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  };

  const groups = useMemo(() => {
    const map = new Map<string, SearchHit[]>();
    for (const hit of form.outcome?.hits ?? []) {
      const list = map.get(hit.path);
      if (list) list.push(hit);
      else map.set(hit.path, [hit]);
    }
    return [...map.entries()];
  }, [form.outcome]);

  const open = (hit: SearchHit) => {
    if (!root) return;
    // 后端回的是相对路径 + `/`，读写文件要绝对路径 + Windows 分隔符
    onOpenFile(joinPath(root, hit.path.replace(/\//g, "\\")), hit.line);
  };

  const toggleMask = (mask: string) => {
    const items = form.include
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const next = items.includes(mask) ? items.filter((i) => i !== mask) : [...items, mask];
    update({ include: next.join(",") });
  };

  const toggleCollapse = (path: string) => {
    update({
      collapsed: form.collapsed.includes(path)
        ? form.collapsed.filter((p) => p !== path)
        : [...form.collapsed, path],
    });
  };

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      update({ query: "" });
    }
  };

  const outcome = form.outcome;
  const collapsedCount = groups.filter(([p]) => form.collapsed.includes(p)).length;
  const allCollapsed = groups.length > 0 && collapsedCount === groups.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {/* ── 条件栏：常驻顶部，结果区滚动时不动 ── */}
      <div className="flex-shrink-0 border-b border-border bg-card px-4 pb-2 pt-3">
        <div className="flex items-center gap-2">
          <div className="relative flex min-w-0 flex-1 items-center">
            <Icon
              name="search"
              size={15}
              className="pointer-events-none absolute left-2.5 text-muted-foreground"
            />
            <input
              value={form.query}
              onChange={(e) => update({ query: e.target.value })}
              onKeyDown={onSearchKey}
              placeholder="在整个工作区搜索（回车）"
              spellCheck={false}
              autoFocus
              list="ncforge-search-history"
              className="h-9 w-full rounded-lg border border-input bg-background pl-8 pr-8 text-[13px] outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30"
            />
            {/* 搜索词历史：datalist 是最省事的原生下拉，不用自己画浮层 */}
            <datalist id="ncforge-search-history">
              {history.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
            {form.query && (
              <button
                type="button"
                title="清空（Esc）"
                onClick={() => update({ query: "" })}
                className="absolute right-2 grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-secondary"
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>

          {/* 三个文本开关挨着输入框常显（VS Code 的位置，但不像它那样收进 ⋯） */}
          <Toggle
            on={form.caseSensitive}
            onClick={() => update({ caseSensitive: !form.caseSensitive })}
            title="区分大小写（默认不区分：搜 billsave 也能命中 billSave）"
          >
            Aa
          </Toggle>
          <Toggle
            on={form.wholeWord}
            disabled={form.regex}
            onClick={() => update({ wholeWord: !form.wholeWord })}
            title={form.regex ? "正则模式下不生效，请自己写 \\b" : "整词匹配"}
          >
            整词
          </Toggle>
          <Toggle
            on={form.regex}
            onClick={() => update({ regex: !form.regex })}
            title="正则表达式（不支持 lookaround / 反向引用，与 VS Code 相同）"
            className="min-w-[42px] text-[13px]"
          >
            .*
          </Toggle>
          <Button size="sm" className="h-9 px-4" onClick={() => void run()} isLoading={loading} loadingText="搜索中">
            搜索
          </Button>
        </div>

        {/* 文件过滤：一个框 + 常用预设，IDEA 的 File mask 语义（`,` 分隔，`!` 排除） */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[11.5px] text-muted-foreground">文件过滤</span>
          <input
            value={form.include}
            onChange={(e) => update({ include: e.target.value })}
            onKeyDown={onSearchKey}
            placeholder="*.java,*.xml,!test*"
            spellCheck={false}
            className="h-7 w-64 rounded-md border border-input bg-background px-2 font-mono text-[11.5px] outline-none placeholder:text-muted-foreground focus:border-ring"
          />
          {MASK_PRESETS.map((mask) => {
            const on = form.include
              .split(",")
              .map((s) => s.trim())
              .includes(mask);
            return (
              <button
                key={mask}
                type="button"
                onClick={() => toggleMask(mask)}
                aria-pressed={on}
                className={`h-6 rounded-full border px-2 text-[11px] transition-colors ${
                  on
                    ? "border-primary/40 bg-primary/10 font-semibold text-primary"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                {mask}
              </button>
            );
          })}
          <span className="ml-auto text-[11px] text-muted-foreground">
            范围：整个工作区 · 自动跳过 .svn .git .idea node_modules
          </span>
        </div>

        {/* 正则语法错之类就地报出来，不弹 toast（要一直看得见才改得对） */}
        {form.error && (
          <div className="mt-2 flex items-start gap-1.5 text-[11.5px] text-destructive-ink">
            <Icon name="alertTriangle" size={13} className="mt-px flex-shrink-0" />
            <span className="break-all">{form.error}</span>
          </div>
        )}
      </div>

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
              onClick={() =>
                update({ collapsed: allCollapsed ? [] : groups.map(([p]) => p) })
              }
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
                    onClick={() => open(hit)}
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
    </div>
  );
}

/** 开关按钮：只表达选中态，动作语义交给 Button。 */
function Toggle({
  on,
  onClick,
  disabled,
  title,
  className = "",
  children,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      title={title}
      className={`h-9 flex-shrink-0 rounded-lg border px-2.5 text-[11.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${className} ${
        on
          ? "border-transparent bg-accent text-accent-foreground"
          : "border-input text-muted-foreground hover:bg-muted"
      }`}
    >
      {children}
    </button>
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
