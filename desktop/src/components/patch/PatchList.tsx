import { Icon } from "../ui/icon";
import { keyOf } from "../../lib/svn";
import {
  countFilters,
  filterItems,
  groupByModule,
  hasProblem,
  layerText,
  pairState,
  selectionStats,
  statsLine,
  type FilterKey,
  type PatchItem,
} from "../../lib/patch";

/**
 * 补丁清单（左栏）：搜索 + 筛选 chip + 按模块分组 + 配对状态。
 *
 * 这一栏是「打什么」的唯一入口，所以每个徽标都得说清一件事：
 * M/A 是 SVN 状态，hyext/标准 是落位层，`2 class` / `未编译` / `过期` 是能不能真打进去。
 * 勾选框只控制「这一项进不进包」，不改变任何判定——判定永远是后端的结论。
 */
export function PatchList({
  items,
  deleted,
  letters,
  scanning,
  picked,
  keyword,
  filter,
  selected,
  onKeyword,
  onFilter,
  onToggle,
  onToggleGroup,
  onSelect,
}: {
  items: PatchItem[];
  deleted: { rel: string }[];
  /**
   * 归一化（`keyOf`）后的绝对路径 → SVN 状态字母（M/A/?）。补丁项本身不带这个信息。
   *
   * 两边路径来源不同，键必须统一：letters 的原始 path 是 Java `File.getPath()` 原样
   * （Windows 反斜杠 + 原大小写），而 `PatchItem.path` 已被 Rust `pv::norm` 改成正斜杠。
   * 直接用原 path 查表在 Windows 上必败，新增文件（A）会一并落到 `?? "M"`。
   */
  letters: Map<string, string>;
  scanning: boolean;
  picked: Set<string>;
  keyword: string;
  filter: FilterKey;
  selected: string | null;
  onKeyword: (v: string) => void;
  onFilter: (f: FilterKey) => void;
  onToggle: (path: string) => void;
  onToggleGroup: (paths: string[], on: boolean) => void;
  onSelect: (path: string) => void;
}) {
  const counts = countFilters(items, picked);
  const shown = filterItems(items, picked, keyword, filter);
  const groups = groupByModule(shown);
  const stats = selectionStats(items, picked);

  const chips: { key: FilterKey; text: string; n: number }[] = [
    { key: "all", text: "全部", n: counts.all },
    { key: "picked", text: "已勾", n: counts.picked },
    { key: "problem", text: "有问题", n: counts.problem },
    { key: "other", text: "非源码", n: counts.other },
  ];

  return (
    <div className="pk-list">
      <div className="pk-top">
        <div className="pk-search">
          <Icon name="search" size={13} />
          <input
            value={keyword}
            placeholder="筛选文件或包名"
            spellCheck={false}
            onChange={(e) => onKeyword(e.target.value)}
          />
          {keyword && (
            <button type="button" className="pk-x" title="清空" onClick={() => onKeyword("")}>
              <Icon name="close" size={11} />
            </button>
          )}
        </div>
        <div className="pk-chips">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              className="pk-chip"
              data-on={filter === c.key || undefined}
              onClick={() => onFilter(c.key)}
            >
              {c.text}
              <span className="n">{c.n}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="pk-rows">
        {scanning && <div className="pk-empty">正在扫描改动并配对 class…</div>}
        {!scanning && items.length === 0 && (
          <div className="pk-empty">
            工作副本里没有可打包的改动。
            <br />
            改完文件、在 IDE 里编译过再来。
          </div>
        )}
        {!scanning && items.length > 0 && shown.length === 0 && (
          <div className="pk-empty">筛选后没有匹配项</div>
        )}

        {groups.map((g) => {
          const paths = g.items.filter((i) => !i.blocked).map((i) => i.path);
          const allOn = paths.length > 0 && paths.every((p) => picked.has(p));
          return (
            <div key={g.module}>
              <div className="pk-grp">
                {g.module}
                <span className="n">{g.items.length}</span>
                <span className="pk-sp" />
                {paths.length > 0 && (
                  <button
                    type="button"
                    className="pk-link"
                    onClick={() => onToggleGroup(paths, !allOn)}
                  >
                    {allOn ? "全不选" : "全选"}
                  </button>
                )}
              </div>
              {g.items.map((it) => (
                <Row
                  key={it.path}
                  item={it}
                  letter={letters.get(keyOf(it.path)) ?? "M"}
                  on={picked.has(it.path)}
                  active={selected === it.path}
                  onToggle={() => onToggle(it.path)}
                  onSelect={() => onSelect(it.path)}
                />
              ))}
            </div>
          );
        })}

        {deleted.length > 0 && filter !== "picked" && (
          <>
            <div className="pk-grp">
              不进补丁
              <span className="n">{deleted.length}</span>
              <span className="pk-sp" />
              <span className="pk-grp-hint">已删除，补丁只加不删</span>
            </div>
            {deleted.map((d) => (
              <div key={d.rel} className="pk-row" data-off>
                <span className="pk-cbx" data-off />
                <span className="pk-badge" data-st="D">
                  D
                </span>
                <span className="pk-fn">{d.rel.split("/").pop()}</span>
                <span className="pk-st">
                  <span className="pk-lay" data-l="del">
                    已删除
                  </span>
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="pk-foot">
        <div className="pk-foot-line">
          <span>{statsLine(stats)}</span>
          <span className="pk-sp" />
          {stats.blocked > 0 && <span className="pk-bad">{stats.blocked} 项阻断</span>}
        </div>
        <div className="pk-prog" title={`已勾 ${stats.picked} / ${stats.total}`}>
          <i className="a" style={{ width: `${stats.percent}%` }} />
        </div>
        {stats.risky > 0 && (
          <div className="pk-foot-line pk-warn">
            <Icon name="alert" size={11} />
            {stats.risky} 项勾了也打不进去（未编译 / class 过期）
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  item,
  letter,
  on,
  active,
  onToggle,
  onSelect,
}: {
  item: PatchItem;
  letter: string;
  on: boolean;
  active: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const pair = pairState(item);
  return (
    <div className="pk-row" data-on={on || undefined} data-active={active || undefined}>
      <button
        type="button"
        className="pk-cbx"
        data-on={on || undefined}
        data-warn={hasProblem(item) || undefined}
        data-off={item.blocked || undefined}
        disabled={item.blocked}
        title={item.blocked ? "这一项有 error，勾了也打不进包" : on ? "取消勾选" : "勾选进包"}
        onClick={onToggle}
      >
        {on && <Icon name="check" size={9} />}
      </button>
      <span className="pk-badge" data-st={letter}>
        {letter}
      </span>
      <button type="button" className="pk-fn" title={item.label} onClick={onSelect}>
        {item.rel.split("/").pop()}
      </button>
      <span className="pk-st">
        <span className="pk-lay" data-l={layerText(item) === "hyext" ? "hy" : "std"}>
          {layerText(item)}
        </span>
        <span className="pk-pair" data-k={pair.kind} title={pair.title}>
          {pair.kind === "ok" ? <Icon name="check" size={10} /> : <Icon name="alert" size={10} />}
          {pair.text}
        </span>
      </span>
    </div>
  );
}
