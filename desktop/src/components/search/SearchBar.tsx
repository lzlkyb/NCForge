import type { KeyboardEvent, ReactNode } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import type { SearchForm } from "../../lib/searchStore";

/** 文件过滤的常用预设：NC 工程的代码在 .java，配置与单据模板在 .xml / .properties。 */
const MASK_PRESETS = ["*.java", "*.xml", "*.properties"];

/**
 * 搜索条件栏（常驻顶部，结果区滚动时不动）。
 *
 * 三个开关挨着输入框常显，不学 VS Code 收进「⋯」——整页横向空间够，
 * 收纳后不给快捷键基本想不起来。
 */
export function SearchBar({
  form,
  history,
  loading,
  update,
  onSearch,
  onKeyDown,
}: {
  form: SearchForm;
  history: string[];
  loading: boolean;
  update: (patch: Partial<SearchForm>) => void;
  onSearch: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
}) {
  const toggleMask = (mask: string) => {
    const items = form.include
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const next = items.includes(mask) ? items.filter((i) => i !== mask) : [...items, mask];
    update({ include: next.join(",") });
  };

  return (
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
            onKeyDown={(e) => onKeyDown(e)}
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
        <Button size="sm" className="h-9 px-4" onClick={onSearch} isLoading={loading} loadingText="搜索中">
          搜索
        </Button>
      </div>

      {/* 文件过滤：一个框 + 常用预设，IDEA 的 File mask 语义（`,` 分隔，`!` 排除） */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-[11.5px] text-muted-foreground">文件过滤</span>
        <input
          value={form.include}
          onChange={(e) => update({ include: e.target.value })}
          onKeyDown={(e) => onKeyDown(e)}
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
