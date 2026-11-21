import type { KeyboardEvent, ReactNode } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { ComponentScopeMenu } from "./ComponentScopeMenu";
import { ScopeChip } from "./ScopeChip";
import type { SearchForm } from "../../lib/searchStore";
import type { ManifestAudit } from "../../lib/ncManifest";
import type { ComponentOption } from "../../lib/searchScope";
import { pasteSearchText } from "../../lib/searchInput";

/** 文件过滤的常用预设：NC 工程的代码在 .java，配置与单据模板在 .xml / .properties。 */
const MASK_PRESETS = ["*.java", "*.xml", "*.properties"];

/**
 * 搜索条件栏（常驻顶部，结果区滚动时不动）。
 *
 * 嵌入浮层时复用顶部输入框，范围与三个开关常显，文件过滤放在「更多」。
 */
export function SearchBar({
  embedded = false,
  form,
  history,
  loading,
  projectCount,
  currentName,
  components,
  audit,
  update,
  onScope,
  onPickComponent,
  onSearch,
  onKeyDown,
}: {
  embedded?: boolean;
  form: SearchForm;
  history: string[];
  loading: boolean;
  /** 可搜索的关联工程数（含当前，磁盘上存在的才计）。 */
  projectCount: number;
  /** 当前工作区名字，用于「当前工程」范围的提示。 */
  currentName: string;
  /** 业务组件清单（manifest）；空 = 「按组件」不可用。 */
  components: ComponentOption[];
  /** 登记缺口：组件菜单底部那行「另有 N 个模块未登记」。 */
  audit: ManifestAudit | null;
  update: (patch: Partial<SearchForm>) => void;
  onScope: (scope: SearchForm["scope"]) => void;
  onPickComponent: (name: string) => void;
  onSearch: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
}) {
  const Input = form.query.includes("\n") ? "textarea" : "input";
  const toggleMask = (mask: string) => {
    const items = form.include
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const next = items.includes(mask) ? items.filter((i) => i !== mask) : [...items, mask];
    update({ include: next.join(",") });
  };

  // 当前范围的短说明：底部那行要一直看得见「现在搜的是哪儿」，别让人对着旧结果猜
  const scopeHint =
    form.scope === "all"
      ? "全部关联工程 · 逐个扫描"
      : form.scope === "component" && form.component
        ? `组件 ${form.component} · 只搜这个模块`
        : currentName
          ? `当前工程 ${currentName}`
          : "当前工作区";

  return (
    <div className={`${embedded ? "qp-search-options " : ""}flex-shrink-0 border-b border-border bg-card px-3 pb-2 pt-3`}>
      {!embedded && <div className="flex items-center gap-2">
        <div className="relative flex min-w-0 flex-1 items-center rounded-md border border-input bg-background" data-focus-container>
          <Icon
            name="search"
            size={15}
            className="pointer-events-none absolute left-2.5 text-muted-foreground"
          />
          <Input
            value={form.query}
            onChange={(e) => update({ query: e.target.value })}
            onKeyDown={(e) => onKeyDown(e)}
            onPaste={(e) => pasteSearchText(e, form.query, query => update({ query }))}
            placeholder={
              form.scope === "all"
                ? "搜索全部关联工程（回车）"
                : form.scope === "component" && form.component
                  ? `在组件 ${form.component} 里搜索（回车）`
                  : "搜索当前工程（回车）"
            }
            spellCheck={false}
            aria-label="搜索工程文件内容"
            autoFocus
            {...(Input === "textarea" ? { rows: 2 } : { list: "ncforge-search-history" })}
            className={`w-full rounded-md border-0 bg-transparent pl-8 pr-8 text-[13px] transition-colors placeholder:text-muted-foreground ${Input === "textarea" ? "resize-none py-1" : "h-[30px]"}`}
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
              aria-label="清空搜索词"
              onClick={() => update({ query: "" })}
              className="absolute right-2 grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-secondary"
            >
              <Icon name="close" size={12} />
            </button>
          )}
        </div>

        <Button size="sm" className="h-9 px-3" onClick={onSearch} isLoading={loading} loadingText="搜索中">
          搜索
        </Button>
      </div>}

      {/* 搜索范围：切换会取消扫描并丢弃旧结果，替换写盘期间则不允许切换。 */}
      <div className="qp-search-scope mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="text-[11.5px] text-muted-foreground">范围</span>
        <ScopeChip
          on={form.scope === "all"}
          disabled={form.replacing}
          onClick={() => onScope("all")}
          title="当前工程 + .classpath 依赖链上的全部工程（默认）"
        >
          全部工程{projectCount > 0 ? ` ${projectCount}` : ""}
        </ScopeChip>
        <ScopeChip
          on={form.scope === "current"}
          disabled={form.replacing}
          onClick={() => onScope("current")}
          title="只搜当前工作区（可替换、可编辑匹配）"
        >
          当前工程
        </ScopeChip>
        <ComponentScopeMenu
          options={components}
          audit={audit}
          value={form.scope === "component" ? form.component : null}
          disabled={form.replacing || components.length === 0}
          onPick={onPickComponent}
        />
      </div>

      {/* 三个文本开关常显（VS Code 的位置，但不像它那样收进 ⋯） */}
      <div className="qp-search-toggles mt-2 flex items-center gap-1.5">
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
        {embedded && <button type="button" className="qp-more" aria-expanded={!!form.more} onClick={() => update({ more: !form.more })}>更多</button>}
      </div>

      {/* 文件过滤：一个框 + 常用预设，IDEA 的 File mask 语义（`,` 分隔，`!` 排除） */}
      {(!embedded || form.more) && <div className="qp-search-filters mt-2 flex flex-wrap items-center gap-2">
        <span className="text-[11.5px] text-muted-foreground">文件过滤</span>
        <input
          value={form.include}
          onChange={(e) => update({ include: e.target.value })}
          onKeyDown={(e) => onKeyDown(e)}
          placeholder="*.java,*.xml,!test*"
          spellCheck={false}
          aria-label="文件过滤"
          className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-[11.5px] outline-none placeholder:text-muted-foreground focus:border-ring"
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
        <span className="w-full text-[11px] text-muted-foreground">
          {scopeHint} · 跳过 .svn .git .idea node_modules
        </span>
      </div>}

      {/* 正则语法错之类就地报出来，不弹 toast（要一直看得见才改得对） */}
      {form.error && (
        <div className="qp-search-error mt-2 flex items-start gap-1.5 text-[11.5px] text-destructive-ink">
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
