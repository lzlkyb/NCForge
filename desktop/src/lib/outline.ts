// 文件结构（大纲）：把 `documentSymbol` 的扁平结果变成可以在弹层里展开的树。
//
// 为什么单独一个文件：建树与过滤都是纯函数，能单测；组件里只剩「输入框 + 行」。
// 树的形状有两种来源（LSP 的两种返回形态），所以 depth 不能直接用——
// 见 buildOutline 里的说明。
import type { FlatSymbol } from "./symbols";

/** 树节点。`depth` 是**渲染缩进**，不等于符号原本的 depth（过滤后可能被压平）。 */
export interface OutlineNode {
  sym: FlatSymbol;
  depth: number;
  children: OutlineNode[];
}

/** 渲染用的一行（树摊平后给列表）。 */
export interface OutlineRow {
  sym: FlatSymbol;
  depth: number;
}

/**
 * 扁平符号 → 树。
 *
 * `documentSymbol` 有两种返回形态：
 * - 层级形态（`DocumentSymbol`）：`depth` 已经是嵌好的；
 * - 平铺形态（`SymbolInformation`）：`depth` 全是 0，嵌套关系藏在 `containerName` 里
 *   （`com.nc.bo.VoucherBO.save` 这种点号串）。
 *
 * 只信 `depth > 0` 是不够的：平铺形态下整棵树会摊成一层。所以 depth 为 0 且带 container
 * 时按容器名的段数补一个深度。深度只用于缩进，算偏了最多是缩进难看，不会丢符号。
 */
export function buildOutline(syms: FlatSymbol[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const sym of syms) {
    const depth = sym.depth > 0 ? sym.depth : sym.container ? sym.container.split(".").length : 0;
    const node: OutlineNode = { sym, depth, children: [] };
    // 同级或更浅的先弹出，栈顶就是父节点
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent && parent.depth < depth) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

/**
 * 按名字过滤，**保留命中项的祖先**。
 *
 * 只留命中节点会让一个方法显示在最外层，看不出它属于哪个类；搜「save」时
 * 上面挂着 `VoucherBO` 那一下，就是人判断「是不是这个 save」的依据。
 */
export function filterOutline(nodes: OutlineNode[], query: string): OutlineNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const walk = (list: OutlineNode[]): OutlineNode[] => {
    const out: OutlineNode[] = [];
    for (const n of list) {
      const kids = walk(n.children);
      const hit = n.sym.name.toLowerCase().includes(q) || n.sym.container.toLowerCase().includes(q);
      if (hit || kids.length > 0) out.push({ sym: n.sym, depth: n.depth, children: kids });
    }
    return out;
  };
  return walk(nodes);
}

/** 树摊平成渲染行，`depth` 重新从 0 开始数（过滤后祖先被保留，缩进跟着变）。 */
export function outlineRows(nodes: OutlineNode[], depth = 0): OutlineRow[] {
  const out: OutlineRow[] = [];
  for (const n of nodes) {
    out.push({ sym: n.sym, depth });
    if (n.children.length > 0) out.push(...outlineRows(n.children, depth + 1));
  }
  return out;
}

/** 键盘上下移动高亮行：到头就停住，不循环（循环会让人以为还有下一项）。 */
export function moveActive(rows: number, active: number, delta: number): number {
  if (rows === 0) return -1;
  const next = active < 0 ? 0 : active + delta;
  return Math.min(Math.max(0, next), rows - 1);
}
