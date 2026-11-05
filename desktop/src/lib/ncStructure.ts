// NC 结构视图：把业务组件模块的 `src` 这一层摊平。
//
// manifest 登记的业务组件长这样（newar/bill）：
//
//     bill/
//       src/public/…  src/client/…  src/private/…  src/test/…  resources/…
//
// 比 Eclipse / IDEA 多一层 `src`：想看到源码根必须先展开两次。本模块把「`src`
// 不出现在树里、它的子目录按真实路径挂到模块这一层」算清楚，渲染（TreeRows）与
// 键盘导航（treeNav.flattenTree）共用同一份，否则必然出现「看着是 5 行、方向键
// 却停在看不见的行上」。
//
// 🔴 不引入虚拟节点：摊平后行上的路径仍是**真实磁盘路径**（`bill/src/public`），
// 只是它的父目录记成 `bill/src`。展开态、压缩链、reveal 全部照旧按真实路径走，
// 不需要动 `dirs` 缓存，也不会有第二套路径口径。
import { joinPath, type DirItem } from "./workspace";
import type { TreeDirState } from "./workspaceSession";

/** NC 模块的源码根目录名（`src/public` 里的 `src`）。 */
export const SRC_DIR = "src";

export interface TreeChild {
  /** 真实父目录：拼路径、找压缩链、判断展开态都按它。 */
  dir: string;
  item: DirItem;
  /** 源码根的展示路径；真实目录仍由 dir + item.name 给出。 */
  label?: string;
  kind?: "source" | "package" | "folder";
}

export interface HoistOpts {
  /** 这一层要不要摊平（pref 开 + 目录是登记过的业务组件）。 */
  hoist: boolean;
  dirs: Record<string, TreeDirState>;
}

/**
 * 这一层要显示的子项。默认原样返回；摊平时把 `src` 换成它的子目录。
 *
 * `src` 还没读出来时它也不显示（子目录晚一帧到，由 `useTreeLoad` 预读补上）；
 * 但**读失败**要把 `src` 原样露出来——否则错误被吞掉，用户只看到模块「缺东西」。
 */
export function visibleChildren(dir: string, items: DirItem[], opts: HoistOpts): TreeChild[] {
  if (!opts.hoist) return items.map((item) => ({ dir, item }));
  // 按真实名字拼路径：磁盘上是 `Src` 时不能拼成 `src`，否则查不到已加载的那一层
  const srcItem = items.find((i) => i.isDir && i.name.toLowerCase() === SRC_DIR);
  if (!srcItem) return items.map((item) => ({ dir, item }));
  const src = joinPath(dir, srcItem.name);
  const inner = opts.dirs[src];
  if (inner?.status === "error") return items.map((item) => ({ dir, item }));
  const innerItems = inner?.status === "ok" ? inner.items : [];
  const out: TreeChild[] = [];
  for (const item of items) {
    if (item === srcItem) {
      for (const sub of innerItems) out.push({ dir: src, item: sub });
      continue;
    }
    out.push({ dir, item });
  }
  return out;
}

/**
 * 摊平后少算几层：`bill/src/public` 跟 `bill/resources` 在树里是同级。
 *
 * `hoisted` 由调用方判断（只有它同时知道 pref 与 manifest），这里只负责算术；
 * 返回值只有 0 / -1，因为被摊掉的只有 `src` 这一层。
 */
export function ncDepthOffset(root: string, path: string, hoisted?: (dir: string) => boolean): number {
  if (!hoisted || !path) return 0;
  // 只算当前工作区底下的路径：多工程树里关联工程各有各的根，按 `root` 硬切会切出
  // 别人的片段（`C:\w\lib\bill\src\public` 按 `C:\w\newar` 切是 `ill\bill\…`），
  // 段数一错就可能把别人的目录误判成「本工作区的 bill 模块」而少算一层。
  // 只认前缀不够：`rootbill` 也以 `root` 开头，还得要求紧跟一个分隔符。
  const head = root.replace(/[\\/]+$/, "");
  const sep = path.charAt(head.length);
  if (
    path.slice(0, head.length).toLowerCase() !== head.toLowerCase() ||
    (sep !== "\\" && sep !== "/")
  ) {
    return 0;
  }
  const rel = path.slice(head.length + 1).replace(/^[\\/]+/, "");
  const seg = rel.split(/[\\/]/).filter(Boolean);
  // `bill/src` 本身是隐藏的，只有它下面的目录才需要抬一层
  if (seg.length < 3 || seg[1].toLowerCase() !== SRC_DIR) return 0;
  return hoisted(joinPath(root, seg[0])) ? -1 : 0;
}
