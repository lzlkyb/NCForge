import { useMemo, useState } from "react";
import { Icon } from "../ui/icon";
import { keyOf, letterTone, reviewProgress, type ChangeItem, type ChangesView } from "../../lib/svn";

type Filter = "all" | "changed" | "untracked" | "conflict";

const FILTER_LABEL: Record<Filter, string> = {
  all: "全部",
  changed: "已改",
  untracked: "未纳管",
  conflict: "冲突",
};

function matchesFilter(item: ChangeItem, filter: Filter): boolean {
  switch (filter) {
    case "changed":
      return item.letter !== "?" && item.letter !== "C";
    case "untracked":
      return item.letter === "?";
    case "conflict":
      return item.letter === "C";
    default:
      return true;
  }
}

/**
 * 改动列表（左栏）：按模块分组 + 状态徽标 + 审查进度。
 *
 * 过滤与搜索都在本地做：一次 status 已经拿到全部条目（过滤后通常几十条），
 * 再往后端跑一趟只会让每敲一个字都等一次 IPC。
 */
export function ChangeList({
  view,
  reviewed,
  selected,
  loading,
  onSelect,
  showIgnored,
  onToggleIgnored,
}: {
  view: ChangesView;
  reviewed: Set<string>;
  selected: string | null;
  loading: boolean;
  onSelect: (item: ChangeItem) => void;
  showIgnored: boolean;
  onToggleIgnored: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());

  // 「显示全部」是纯本地开关：后端一次就把构建产物一起给了（带 ignored 标记），
  // 按开关重扫一遍要等 7.6 秒，纯浪费。
  const visible = useMemo(
    () =>
      view.groups
        .map((g) => ({
          module: g.module,
          items: g.items.filter((it) => showIgnored || !it.ignored),
        }))
        .filter((g) => g.items.length > 0),
    [view, showIgnored],
  );

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, changed: 0, untracked: 0, conflict: 0 };
    for (const g of visible) {
      for (const it of g.items) {
        c.all += 1;
        for (const f of ["changed", "untracked", "conflict"] as Filter[]) {
          if (matchesFilter(it, f)) c[f] += 1;
        }
      }
    }
    return c;
  }, [visible]);

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return visible
      .map((g) => ({
        module: g.module,
        items: g.items.filter(
          (it) =>
            matchesFilter(it, filter) &&
            (q === "" || it.rel.toLowerCase().includes(q) || it.path.toLowerCase().includes(q)),
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [visible, filter, search]);

  // 进度只按非构建产物算：把几百个 .class 算进分母，「已审 2 / 540」没有任何意义。
  // 注意分母与「显示全部」开关无关——打开开关是为了看见它们，不是为了把它们列进审查清单。
  const progress = useMemo(() => {
    const counted = view.groups
      .map((g) => ({ module: g.module, items: g.items.filter((it) => !it.ignored) }))
      .filter((g) => g.items.length > 0);
    return reviewProgress({ groups: counted, shown: 0, total: 0, ignored: 0 }, reviewed);
  }, [view, reviewed]);

  const toggleGroup = (module: string) => {
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(module)) next.delete(module);
      else next.add(module);
      return next;
    });
  };

  return (
    <aside className="vc-chg">
      <div className="vc-chg-top">
        <div className="vc-search">
          <Icon name="search" size={13} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="筛选文件，支持 / 分段"
            spellCheck={false}
          />
        </div>
        <div className="vc-chips">
          {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              className="vc-chip"
              data-on={filter === f || undefined}
              onClick={() => setFilter(f)}
            >
              {FILTER_LABEL[f]}
              <span className="n">{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="vc-list">
        {/* 首次扫描要 7 秒左右（12757 个条目）。这段时间显示「干净」是假话，
            用户会以为改动丢了、转头去 Eclipse 里找。 */}
        {loading && view.total === 0 && (
          <div className="vc-empty">
            <Icon name="spinner" size={22} className="vc-spin" />
            <div>
              正在扫描工作副本…
              <br />
              这个工程有上万个条目，首次要几秒
            </div>
          </div>
        )}
        {groups.length === 0 && !(loading && view.total === 0) && (
          <div className="vc-empty">
            <Icon name="check" size={22} />
            <div>
              {view.total === 0
                ? "工作副本是干净的，没有本地改动"
                : view.shown === 0 && view.ignored > 0
                  ? `只有 ${view.ignored} 条构建产物，没有真实改动`
                  : "当前筛选没有匹配的文件"}
            </div>
          </div>
        )}
        {groups.map((g) => {
          const isClosed = closed.has(g.module);
          return (
            <div key={g.module}>
              <button type="button" className="vc-grp" data-closed={isClosed || undefined} onClick={() => toggleGroup(g.module)}>
                <Icon name="chevronDown" size={12} />
                {g.module}
                <span className="n">{g.items.length}</span>
              </button>
              {!isClosed &&
                g.items.map((it) => {
                  const name = it.rel.slice(it.rel.lastIndexOf("/") + 1);
                  const dir = it.rel.includes("/") ? it.rel.slice(0, it.rel.lastIndexOf("/")) : "";
                  const tone = letterTone(it.letter);
                  return (
                    <button
                      key={it.path}
                      type="button"
                      className="vc-row"
                      data-on={selected === it.path || undefined}
                      data-reviewed={reviewed.has(keyOf(it.path)) || undefined}
                      onClick={() => onSelect(it)}
                      title={it.rel}
                    >
                      <span className="vc-badge" data-st={tone}>
                        {it.letter}
                      </span>
                      <span className="vc-fn">{name}</span>
                      {dir && <span className="vc-dir">{dir.split("/").slice(-2).join("/")}</span>}
                    </button>
                  );
                })}
            </div>
          );
        })}
      </div>

      <div className="vc-chg-foot">
        <div style={{ display: "flex", gap: 6 }}>
          <span>审查进度</span>
          <span className="vc-sp" />
          <span>
            已审 <b>{progress.done}</b> / {progress.total}
          </span>
        </div>
        <div className="vc-prog">
          <i style={{ width: `${progress.percent}%` }} />
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span>{showIgnored ? `含构建产物，共 ${view.total} 条` : `已隐藏 ${view.ignored} 条构建产物`}</span>
          <span className="vc-sp" />
          <button type="button" className="vc-chip" style={{ height: 20, padding: "0 7px" }} onClick={onToggleIgnored}>
            {showIgnored ? "隐藏" : "显示全部"}
          </button>
        </div>
      </div>
    </aside>
  );
}
