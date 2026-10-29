import { useState } from "react";
import { Icon } from "../ui/icon";
import { countEntries, type TreeNode } from "../../lib/patchTree";

/**
 * 落位预览：zip 里的目录树。
 *
 * 这是**唯一的真相展示**——用户会盯着它确认「这个 class 到底落在 hyext 还是标准层」。
 * 所以这里只渲染后端算出来的 `target`，不在前端做任何「应该放哪」的补充判断。
 * 目录默认全展开：补丁要确认的就是完整落位，折叠起来反而要多点几下。
 */
export function StageTree({ nodes, hint }: { nodes: TreeNode[]; hint: string }) {
  // 存「折叠起来的目录 id」，而不是「展开的」——默认全展开才是这里想要的初始状态
  const [folded, setFolded] = useState<Set<string>>(new Set());

  if (nodes.length === 0) {
    return (
      <div className="pk-tree-empty">
        <Icon name="package" size={20} />
        <span>{hint}</span>
      </div>
    );
  }

  const toggle = (id: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <div className="pk-tree-head">
        <Icon name="package" size={13} />
        <span>
          zip 根有 <code>CHANGES.md</code> 与 <code>replacement/</code>
        </span>
        <span className="pk-sp" />
        {/* 说「文件」不说「条目」：出包横幅里的条目数含 zip 目录，两个数不是
            一回事，共用一个词会让用户以为预览少数了东西 */}
        <span>共 {countEntries(nodes)} 个文件</span>
        <button type="button" className="pk-link" onClick={() => setFolded(new Set())}>
          全部展开
        </button>
        <button type="button" className="pk-link" onClick={() => setFolded(new Set(collectDirs(nodes)))}>
          折叠目录
        </button>
      </div>
      <div className="pk-tree">
        {/* key 用下标不用名字：两个同名 SQL（或叫 CHANGES.md 的 SQL）会在根层
            撞名，name 做 key 会被 React 静默去重——预览恰好少数一行 */}
        {nodes.map((n, i) => (
          <Row
            key={i}
            node={n}
            id={n.name}
            prefix=""
            last={i === nodes.length - 1}
            folded={folded}
            onToggle={toggle}
          />
        ))}
      </div>
    </>
  );
}

function collectDirs(nodes: TreeNode[], out: string[] = [], path = ""): string[] {
  for (const n of nodes) {
    const id = path ? `${path}/${n.name}` : n.name;
    if (n.dir && n.children.length > 0) {
      out.push(id);
      collectDirs(n.children, out, id);
    }
  }
  return out;
}

function Row({
  node,
  id,
  prefix,
  last,
  folded,
  onToggle,
}: {
  node: TreeNode;
  /** 完整路径，折叠状态按它记（同名目录出现在不同层也不会串）。 */
  id: string;
  /** 祖先留下的竖线前缀。 */
  prefix: string;
  last: boolean;
  folded: Set<string>;
  onToggle: (id: string) => void;
}) {
  const isFolded = node.dir && folded.has(id);
  const caret = last ? "└─ " : "├─ ";
  const childPrefix = prefix + (last ? "   " : "│  ");
  const canFold = node.dir && node.children.length > 0;

  return (
    <>
      <div className="pk-tn">
        <span className="pk-gh">
          {prefix}
          {caret}
        </span>
        {canFold ? (
          <button type="button" className="pk-tn-name" data-dir onClick={() => onToggle(id)}>
            <Icon name={isFolded ? "chevronRight" : "chevronDown"} size={10} />
            {node.name}
          </button>
        ) : (
          <span className="pk-tn-name" data-dir={node.dir || undefined}>
            {node.name}
          </span>
        )}
        {node.badge && <span className="pk-tn-badge">{node.badge}</span>}
        {node.meta && <span className="pk-tn-meta">{node.meta}</span>}
      </div>
      {!isFolded &&
        node.children.map((c, i) => (
          <Row
            key={i}
            node={c}
            id={`${id}/${c.name}`}
            prefix={childPrefix}
            last={i === node.children.length - 1}
            folded={folded}
            onToggle={onToggle}
          />
        ))}
    </>
  );
}
