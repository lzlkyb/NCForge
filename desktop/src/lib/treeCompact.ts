// 文件树的「压缩中间包」：把 `com → aier → erp → vo` 这种一路只有一个子目录的链条
// 合并成一行 `com.aier.erp.vo`（Eclipse 的 Compact Middle Packages / IDEA 的 Flatten Packages）。
//
// 纯函数，树的渲染（FileTree）与键盘导航（treeNav.flattenTree）共用同一份计算——
// 两边各算一遍必然出现「看着是 5 行、方向键却停在看不见的行上」。
import { joinPath } from "./workspace";
import type { TreeDirState } from "./workspaceSession";

export interface Chain {
  /** 链上每一层的路径（含首层），从外到内。 */
  nodes: string[];
  /** 显示用的名字：`com.aier.erp`。 */
  label: string;
  /** 链尾（真正展开的位置）。 */
  tail: string;
}

/** 合并的最多层数：防止畸形目录（几千层）把渲染拖住。 */
const MAX_DEPTH = 12;

/**
 * 从 `path` 开始向下合并「只有一个子目录且没有文件」的层。
 *
 * 只合并**已经加载过**的目录：没加载就不知道里面是不是只有一个子目录，
 * 猜错会让行在展开瞬间改名。展开时由调用方顺带把链上的目录都加载一遍。
 */
export function collapseChain(
  path: string,
  name: string,
  dirs: Record<string, TreeDirState>,
): Chain {
  const nodes = [path];
  let label = name;
  let tail = path;
  for (let i = 0; i < MAX_DEPTH; i += 1) {
    const st = dirs[tail];
    if (!st || st.status !== "ok") break;
    if (st.items.length !== 1) break;
    const only = st.items[0];
    if (!only.isDir) break;
    const next = joinPath(tail, only.name);
    nodes.push(next);
    label += `.${only.name}`;
    tail = next;
  }
  return { nodes, label, tail };
}

/** 这一行是不是「压缩后的目录」：真则展开态要同时看链上任意一层。 */
export function chainOpen(chain: Chain, expanded: Set<string>): boolean {
  return chain.nodes.some((n) => expanded.has(n));
}

const isUnder = (path: string, dir: string) =>
  path.toLowerCase() === dir.toLowerCase() ||
  path.toLowerCase().startsWith(dir.toLowerCase() + "\\");

/**
 * 已知链尾与它所在的父目录，还原整条链。
 *
 * 收起时必须把链上每一层都从 `expanded` 里删掉：只删链尾的话，上一层还开着，
 * 下一帧又会被 `chainOpen` 判成展开，看起来像"点了没反应"。
 */
export function chainFor(
  tail: string,
  parent: string | null,
  dirs: Record<string, TreeDirState>,
): Chain {
  if (!parent) return { nodes: [tail], label: tail, tail };
  const st = dirs[parent];
  const start = st?.status === "ok"
    ? st.items.find((i) => i.isDir && isUnder(tail, joinPath(parent, i.name)))
    : undefined;
  if (!start) return { nodes: [tail], label: tail, tail };
  return collapseChain(joinPath(parent, start.name), start.name, dirs);
}
