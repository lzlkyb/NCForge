import type { PatchItem } from "./patch";

/**
 * 「落位预览」树的纯逻辑：把选中的补丁项摊成 zip 里的目录树。
 *
 * 为什么单独一个文件：树是**界面唯一的真相展示**——用户会盯着它确认「这个 class
 * 到底落在 hyext 还是标准层」。它必须完全由后端给的 `target` 与 `classes` 推出来，
 * 不能在前端再加一层「我认为应该放哪」的判断，否则显示的和打出来的会不一致。
 */

export interface TreeNode {
  name: string;
  dir: boolean;
  /** 右侧灰字：`内部类`、`源码一并带`、`整文件替换`。 */
  meta?: string;
  /** 右侧强调色字：`public` / `client` / `标准层`。 */
  badge?: string;
  children: TreeNode[];
}

/** 取路径最后一段（Windows 与 POSIX 分隔符都认）。 */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** `replacement/modules/ic/META-INF/hyext/classes/nc/bs` → 段数组。 */
function segments(target: string): string[] {
  return target.split(/[\\/]/).filter(Boolean);
}

function insert(level: TreeNode[], segs: string[], leaf: TreeNode): void {
  if (segs.length === 1) {
    const exist = level.find((n) => n.name === segs[0] && !n.dir);
    if (!exist) level.push(leaf);
    return;
  }
  const [head, ...rest] = segs;
  let dir = level.find((n) => n.name === head && n.dir);
  if (!dir) {
    dir = { name: head, dir: true, children: [] };
    level.push(dir);
  }
  insert(dir.children, rest, leaf);
}

/**
 * 每一层按名字排（目录与文件混排，跟 zip 查看器看到的一致）。
 *
 * 刻意不「目录优先」：用户在资源管理器里看到的是目录优先，但补丁包看的是
 * **zip 里的顺序**——两者不一致会让人在「预览里第 3 行」和「解压后第 3 行」之间对不上。
 * 根层不排序：`CHANGES.md` 与 SQL 固定在最前（脚本约定，也是人最先要看的东西）。
 */
function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  for (const n of nodes) if (n.children.length > 0) sortTree(n.children);
}

const SECTION_BADGE: Record<string, string> = {
  public: "public",
  private: "private",
  client: "client",
};

/** 一项会往 zip 里放哪些文件（class + 内部类 + 源码 + upm/网页整文件）。 */
function leavesOf(item: PatchItem): TreeNode[] {
  const out: TreeNode[] = [];
  if (item.section === "upm") {
    out.push({ name: baseName(item.path), dir: false, meta: "整文件替换", children: [] });
    return out;
  }
  if (item.section === "hotwebs") {
    out.push({ name: baseName(item.path), dir: false, meta: "部署到 NC home", children: [] });
    return out;
  }
  const java = baseName(item.path);
  const stem = java.replace(/\.java$/i, "");
  const badge = SECTION_BADGE[item.section];
  for (const c of item.classes) {
    const inner = c.name.startsWith(`${stem}$`);
    out.push({
      name: c.name,
      dir: false,
      meta: inner ? "内部类" : undefined,
      badge: inner ? undefined : badge,
      children: [],
    });
  }
  // 源码与 class 并排打进包——脚本就是这么做的，运维靠它反查线上行为。
  out.push({ name: java, dir: false, meta: "源码一并带", children: [] });
  return out;
}

/**
 * 把「只有一个子目录」的链条合并成一行：`META-INF/hyext/classes/nc/bs/ic/eye/crossborrow`。
 *
 * 不合并的话，一条落位路径要占十行（每层一段），一屏只看得到两三个文件，
 * 「这个 class 落在 hyext 还是标准层」这件事反而看不出来了。设计稿也是这么收的。
 *
 * 两个刻意的限制：
 * - **前三层不合并**（`replacement/` → `modules/` → `<模块>/`）：这三层是固定的、
 *   每屏都该一眼看到；把它们揉成一行只会让「这是哪个模块的包」变得难认。
 * - **合并到出现分叉就停**：分叉点才是需要人看的地方（例如 `META-INF` 下同时有
 *   `.upm` 和 `hyext/`）。
 */
function compress(nodes: TreeNode[], depth: number): void {
  for (const n of nodes) {
    if (!n.dir) continue;
    compress(n.children, depth + 1);
    if (depth < 3) continue;
    while (n.children.length === 1 && n.children[0].dir) {
      const only = n.children[0];
      n.name = `${n.name}/${only.name}`;
      n.children = only.children;
    }
  }
}

/**
 * 生成整棵树。`CHANGES.md` 永远在 zip 根，SQL 文件也在根（脚本约定）。
 * `replacement/` 下按模块 → 落位目录层层展开，单链路径合并成一行。
 */
export function buildStageTree(items: PatchItem[], sqls: string[]): TreeNode[] {
  const root: TreeNode[] = [{ name: "CHANGES.md", dir: false, meta: "自动生成", children: [] }];
  // SQL 放 zip 根：运维执行前会先看根目录，埋进 replacement 里就找不到了
  for (const s of sqls) {
    root.push({ name: baseName(s), dir: false, meta: "需人工执行", children: [] });
  }
  for (const it of items) {
    const dirSegs = segments(it.target);
    for (const leaf of leavesOf(it)) {
      insert(root, [...dirSegs, leaf.name], leaf);
    }
  }
  // 根层只排子目录内部；CHANGES.md / SQL / replacement 的先后是语义顺序，不按字母重排
  for (const n of root) if (n.children.length > 0) sortTree(n.children);
  compress(root, 0);
  return root;
}

/** zip 里的条目总数（文件数，不含目录）。 */
export function countEntries(nodes: TreeNode[]): number {
  let n = 0;
  for (const x of nodes) n += x.dir ? countEntries(x.children) : 1;
  return n;
}

/** 某个模块树下有多少个 class（用于分组标题的尾注）。 */
export function countClasses(items: PatchItem[]): number {
  return items.reduce((n, it) => n + it.classes.length, 0);
}
