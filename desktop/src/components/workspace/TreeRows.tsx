// 文件树的行渲染（从 FileTree 抽出来的）。
//
// 抽出来的原因：FileTree 还要管菜单、键盘、筛选、自动定位，行渲染本身（含递归与
// 压缩中间包）就有 70 行；两者混在一起会顶爆单文件 300 行的门禁。
//
// 递归渲染：目录展开时直接渲染它的下一层，不额外建虚拟列表（NC 工程一个目录最多几百项）。
import { useJavaTreeKinds } from "../../hooks/useJavaTreeKinds";
import { useCompileMarks } from "../../hooks/useCompileMarks";
import { markOf } from "../../lib/compileMarks";
import { inspectMarkOf, useInspectMarks } from "../../lib/inspectMarks";
import type { MouseEvent as ReactMouseEvent } from "react";
import { javaKindOfSymbol } from "../../lib/treeFileKind";
import { hasJavaMembers, type TreeMembers, type JavaTreeMember } from "../../lib/javaTreeMembers";
import { JavaMemberRows } from "./JavaMemberRows";
import { TreeEditRow } from "./TreeEditRow";
import { TreeDirRow, TreeFileRow, TreeRowNote } from "./TreeRow";
import { joinPath, type EncodingMark } from "../../lib/workspace";
import { chainOpen, dirChain } from "../../lib/treeCompact";
import { bcBadge, type ComponentIndex } from "../../lib/ncManifest";
import { packageChildren, packageCompact, sourceForPath, type PackageRoots, type PackageIndexes } from "../../lib/packageTree";
import { treeRowId as rowId } from "../../lib/treeNav";
import { pathKey } from "../../lib/treeSvn";
import type { TreeDirState } from "../../lib/workspaceSession";
import type { EditState } from "./useTreeEdit";

export interface TreeRowsCtx {
  dirs: Record<string, TreeDirState>;
  expanded: Set<string>;
  activePath: string | null;
  selectedPath: string | null;
  marks: Record<string, EncodingMark>;
  /** 文件 → 书签条数，键已归一（`bookmarkPathKey`）。 */
  bookmarkCounts: Map<string, number>;
  /** 名字筛选（speed search）；空时恒真。 */
  filter: (name: string) => boolean;
  /** 压缩中间包：单链目录合成一行；关掉时每层各占一行。 */
  compact: boolean;
  packageRoots?: PackageRoots;
  packageIndexes?: PackageIndexes;
  members?: TreeMembers;
  onToggleMembers: (path: string) => void;
  onOpenMember: (path: string, member: JavaTreeMember) => void;
  /**
   * 这一层是不是「工程根下的业务组件模块」——只按目录位置与 manifest 判断，
   * 与任何显示偏好无关（徽章与摊平都问它）。
   */
  isBcModule: (dir: string) => boolean;
  /**
   * 这一层的子目录要不要摊平 `src`（NC 结构视图）。
   *
   * 判断放在 `FileTree`（那里才知道 pref、manifest 与工程根），这里只负责执行，
   * 与 `treeNav.flattenTree` 走同一份 `visibleChildren`。
   */
  hoist: (dir: string) => boolean;
  /** 业务组件索引（`manifest.xml`）：工程根下同名的模块目录打「业务组件」徽章。 */
  bcNames: ComponentIndex;
  editing: EditState | null;
  editError: string | null;
  busy: boolean;
  /** 展开 / 收起一条压缩链（tail 是链尾，parent 是链所在的目录）。 */
  onToggle: (tail: string, parent: string) => void;
  /** 展开 / 收起一个关联工程的根（多工程树；不走压缩链）。 */
  onProjectToggle: (path: string) => void;
  /** 点开一个文件：选中它并请求打开（合并成一个稳定回调，行组件才能 memo）。 */
  onActivate: (path: string) => void;
  onPin?: (path: string) => void;
  onContextMenu: (e: ReactMouseEvent, path: string, isDir: boolean) => void;
  onCommitEdit: (value: string) => void;
  onCancelEdit: () => void;
}

function EditRow({ ctx }: { ctx: TreeRowsCtx }) {
  const st = ctx.editing;
  if (!st) return null;
  return (
    <TreeEditRow
      initial={st.initial}
      placeholder={st.placeholder}
      selectStem={st.mode === "rename"}
      isDir={st.isDir}
      padLeft={st.padLeft}
      error={ctx.editError}
      busy={ctx.busy}
      onSubmit={ctx.onCommitEdit}
      onCancel={ctx.onCancelEdit}
    />
  );
}

/** 渲染 `dir` 这一层；目录展开时递归渲染下一层。 */
export function TreeRows({ dir, depth, ctx }: { dir: string; depth: number; ctx: TreeRowsCtx }) {
  const state = ctx.dirs[dir];
  const javaKinds = useJavaTreeKinds(dir, state);
  // 编译问题按目录聚合：模块/包/源码根行先看到「这里有错」，展开后文件行再给具体数
  const marks = useCompileMarks();
  // jdt.ls 代码检查单独一个徽标：只覆盖打开的文件，不能和编译数相加
  const inspectMarks = useInspectMarks();
  const rows: JSX.Element[] = [];
  const notePad = 6 + depth * 14 + 20;
  const creating = ctx.editing && ctx.editing.mode !== "rename" && ctx.editing.parent === dir;

  // 新建的输入行出现在该目录内容的最前面
  if (creating) rows.push(<EditRow key={`edit-${dir}`} ctx={ctx} />);
  if (!state || state.status === "loading") {
    rows.push(
      <TreeRowNote key={`${dir}#l`} padLeft={notePad}>
        加载中…
      </TreeRowNote>,
    );
    return <>{rows}</>;
  }
  if (state.status === "error") {
    rows.push(
      <TreeRowNote key={`${dir}#e`} padLeft={notePad} tone="bad" title={state.message}>
        读取失败：{state.message}
      </TreeRowNote>,
    );
    return <>{rows}</>;
  }

  const kids = packageChildren(dir, state.items, { hoist: ctx.hoist(dir), dirs: ctx.dirs }, ctx.packageRoots, ctx.packageIndexes)
    .filter(({ item, label }) => ctx.filter(label ?? item.name));
  const source = sourceForPath(ctx.packageRoots, dir);
  if (source === dir && ctx.packageIndexes?.get(dir) === undefined) {
    rows.push(<TreeRowNote key={`${dir}#index`} padLeft={notePad}>正在整理包列表…</TreeRowNote>);
  } else if (source === dir && ctx.packageIndexes?.get(dir) === null) {
    rows.push(<TreeRowNote key={`${dir}#index-error`} padLeft={notePad}>包列表读取失败，已显示目录。</TreeRowNote>);
  } else if (kids.length === 0 && !creating) {
    rows.push(
      <TreeRowNote key={`${dir}#0`} padLeft={notePad}>
        {state.items.length === 0 ? "（空目录）" : "没有匹配的项"}
      </TreeRowNote>,
    );
  }

  for (const { dir: from, item, label, kind } of kids) {
    const full = joinPath(from, item.name);
    if (ctx.editing && ctx.editing.mode === "rename" && ctx.editing.target?.toLowerCase() === full.toLowerCase()) {
      rows.push(<EditRow key={`rename-${full}`} ctx={ctx} />);
      continue;
    }
    if (item.isDir) {
      // 压缩中间包：`com → aier → erp` 只有一个子目录时合成一行 `com.aier.erp`
      const chain = dirChain(ctx.compact && packageCompact(ctx.packageRoots, full, ctx.packageIndexes), full, label ?? item.name, ctx.dirs);
      const open = chainOpen(chain, ctx.expanded);
      // 只有工程根下这一层才是 NC 的模块目录；再深就是包/目录，名字对上了也不是组件
      const bc = ctx.isBcModule(full) ? bcBadge(item.name, ctx.bcNames) : undefined;
      rows.push(
        <TreeDirRow
          key={chain.tail}
          name={chain.label}
          path={chain.tail}
          id={rowId(chain.tail)}
          level={depth + 1}
          open={open}
          selected={ctx.selectedPath === chain.tail}
          padLeft={6 + depth * 14}
          parent={from}
          bc={bc}
          sourceRoot={kind === "source"}
          packageDir={kind === "package"}
          problem={markOf(marks, chain.tail)}
          inspect={inspectMarkOf(inspectMarks, chain.tail)}
          onToggle={ctx.onToggle}
          onContextMenu={ctx.onContextMenu}
        />,
      );
      if (open) rows.push(<TreeRows key={`${chain.tail}-kids`} dir={chain.tail} depth={depth + 1} ctx={ctx} />);
    } else {
      const canExpand = !!ctx.members && hasJavaMembers(full);
      const members = ctx.members?.get(full);
      const types = members?.status === "ready" ? members.rows.filter(row => row.depth === 0) : undefined;
      const javaKind = types ? (types.length === 1 ? javaKindOfSymbol(types[0].kind) : undefined) : javaKinds[item.name];
      rows.push(
        <TreeFileRow
          key={full}
          name={item.name}
          path={full}
          id={rowId(full)}
          level={depth + 1}
          active={ctx.activePath === full}
          selected={ctx.selectedPath === full}
          mark={ctx.marks[full]}
          javaKind={javaKind}
          problem={markOf(marks, full)}
          inspect={inspectMarkOf(inspectMarks, full)}
          memberExpanded={canExpand ? !!members : undefined}
          onToggleMembers={canExpand ? ctx.onToggleMembers : undefined}
          bookmarks={ctx.bookmarkCounts.get(pathKey(full)) ?? 0}
          padLeft={6 + depth * 14 + 20}
          onOpen={ctx.onActivate}
          onPin={ctx.onPin}
          onContextMenu={ctx.onContextMenu}
        />,
      );
      if (members) rows.push(<JavaMemberRows key={`${full}-symbols`} state={members} depth={depth + 1}
        selected={ctx.selectedPath} onJump={member => ctx.onOpenMember(full, member)} />);
    }
  }
  return <>{rows}</>;
}
