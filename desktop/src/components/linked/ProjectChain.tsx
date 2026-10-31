import { useState } from "react";
import { Icon } from "../ui/icon";
import {
  originLabel,
  overrideHits,
  type LinkedGraph,
  type LinkedOverride,
  type LinkedProject,
  type OverrideAction,
} from "../../lib/linkedProjects";

/**
 * 依赖链只读视图（+ 行内的覆盖快捷按钮）。
 *
 * 行的**顺序**就是真正塞进 classpath 的顺序，所以带序号显示——这不是装饰：
 * `pm` 与 `newar` 有 18 个同名类内容不同，谁在前谁赢（见 `eclipse_cp_live` 断言）。
 * 用户调 `front` 时看的就是这个顺序。
 *
 * 只读部分是事实，快捷按钮只改**草稿**（父组件持有），点保存才落盘。
 */
export function ProjectChain({
  graph,
  overrides,
  onToggle,
}: {
  graph: LinkedGraph;
  overrides: LinkedOverride[];
  onToggle: (action: OverrideAction, p: LinkedProject) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleRow = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <section className="lnk-sec">
      <h3 className="lnk-sec-title">
        依赖链
        <span className="lnk-hint">顺序 = 真正塞进 classpath 的顺序，排在前面的同名类优先</span>
      </h3>

      <ol className="lnk-chain">
        {graph.projects.map((p, i) => (
          <ChainRow
            key={`${p.name}-${i}`}
            index={i}
            p={p}
            overrides={overrides}
            expanded={expanded.has(p.name)}
            onToggleRow={() => toggleRow(p.name)}
            onToggle={onToggle}
          />
        ))}
      </ol>

      <div className="lnk-sum">
        <span>
          类目录 <b>{graph.totalDirCount}</b> 个
        </span>
        <span className="lnk-hint">
          工程侧 {graph.projectDirCount} + NC home {graph.ncHomeDirCount}
        </span>
        {graph.extraDirs.length > 0 && (
          <span className="lnk-hint">覆盖表追加 {graph.extraDirs.length}</span>
        )}
      </div>

      {graph.extraDirs.length > 0 && (
        <div className="lnk-extra">
          <span className="lnk-hint">追加目录</span>
          {graph.extraDirs.map((d) => (
            <code key={d} className="lnk-dir">
              {d}
            </code>
          ))}
        </div>
      )}

      {graph.notes.length > 0 && (
        <div className="lnk-notes">
          <span className="lnk-hint">解析说明（改的类没生效时先看这里）</span>
          <ul>
            {graph.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ChainRow({
  index,
  p,
  overrides,
  expanded,
  onToggleRow,
  onToggle,
}: {
  index: number;
  p: LinkedProject;
  overrides: LinkedOverride[];
  expanded: boolean;
  onToggleRow: () => void;
  onToggle: (action: OverrideAction, p: LinkedProject) => void;
}) {
  const drafted = (action: OverrideAction) =>
    overrides.some((o) => o.action === action && overrideHits(o, p));
  const disabled = p.disabled;
  const fronted = p.origin === "front";
  const isPrimary = p.origin === "primary";

  return (
    <li className="lnk-item" data-disabled={disabled || undefined}>
      <div className="lnk-row">
        <span className="lnk-idx">{index + 1}</span>
        <button
          type="button"
          className="lnk-name"
          onClick={onToggleRow}
          title={p.root ?? "`.classpath` 里写了，但磁盘上找不到这个工程"}
        >
          <Icon name={expanded ? "chevronDown" : "chevronRight"} size={12} />
          {p.name}
        </button>
        <span className="lnk-badge" data-kind={p.origin}>
          {originLabel(p.origin)}
        </span>
        {!isPrimary && <span className="lnk-meta">depth {p.depth}</span>}
        <span
          className="lnk-meta"
          title={'引入它的那条边是否 exported="true"（决定它会不会继续往下传递）'}
        >
          {p.exported ? "往下传递" : "不传递"}
        </span>
        <span className="lnk-dirs" title="这个工程贡献的类目录数">
          {p.classDirs.length} 个目录
        </span>
        {!p.hasClasspath && <span className="lnk-badge" data-kind="warn">无 .classpath</span>}
        {p.root === null && (
          <span className="lnk-badge" data-kind="bad">目录找不到</span>
        )}
        {disabled && <span className="lnk-badge" data-kind="muted">已停用</span>}

        <span className="lnk-sp" />

        {!isPrimary && (
          <button
            type="button"
            className="lnk-btn"
            data-on={drafted("disable") || undefined}
            onClick={() => onToggle("disable", p)}
            title="停用后这个工程不参与类路径，它往下传递的依赖一起剪掉"
          >
            {disabled ? "已停用 · 点此恢复" : drafted("disable") ? "取消停用" : "停用"}
          </button>
        )}
        <button
          type="button"
          className="lnk-btn"
          data-on={drafted("front") || undefined}
          disabled={isPrimary}
          onClick={() => onToggle("front", p)}
          title={isPrimary ? "主工程已经排第一" : "排到主工程之后、其它依赖之前"}
        >
          {fronted || drafted("front") ? "取消排前" : "排前"}
        </button>
      </div>

      {expanded && (
        <div className="lnk-detail">
          <div className="lnk-root">
            <span className="lnk-hint">工程根</span>
            <code className="lnk-dir">{p.root ?? "（磁盘上找不到）"}</code>
          </div>
          {p.classDirs.length === 0 ? (
            <p className="lnk-empty">
              {disabled
                ? "被覆盖表停用，不贡献类目录"
                : p.hasClasspath
                  ? "`.classpath` 里没有可用的 output 目录"
                  : "老工程启发式也没找到 classes / out / bin"}
            </p>
          ) : (
            <div className="lnk-dirbox">
              {p.classDirs.map((d) => (
                <code key={d} className="lnk-dir">
                  {d}
                </code>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
