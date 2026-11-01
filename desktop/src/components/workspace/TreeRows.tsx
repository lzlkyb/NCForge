// 文件树的行渲染（从 FileTree 抽出来的）。
//
// 抽出来的原因：FileTree 还要管菜单、键盘、筛选、自动定位，行渲染本身（含递归与
// 压缩中间包）就有 70 行；两者混在一起会顶爆单文件 300 行的门禁。
//
// 递归渲染：目录展开时直接渲染它的下一层，不额外建虚拟列表（NC 工程一个目录最多几百项）。
import type { MouseEvent as ReactMouseEvent } from "react";
import { TreeEditRow } from "./TreeEditRow";
import { TreeDirRow, TreeFileRow, TreeRowNote } from "./TreeRow";
import { joinPath, type EncodingMark } from "../../lib/workspace";
import { chainOpen, collapseChain } from "../../lib/treeCompact";
import { treeRowId as rowId } from "../../lib/treeNav";
import type { TreeDirState } from "../../lib/workspaceSession";
import type { EditState } from "./useTreeEdit";

export interface TreeRowsCtx {
  dirs: Record<string, TreeDirState>;
  expanded: Set<string>;
  activePath: string | null;
  selectedPath: string | null;
  marks: Record<string, EncodingMark>;
  /** 名字筛选（speed search）；空时恒真。 */
  filter: (name: string) => boolean;
  editing: EditState | null;
  editError: string | null;
  busy: boolean;
  /** 展开 / 收起一条压缩链（tail 是链尾，parent 是链所在的目录）。 */
  onToggle: (tail: string, parent: string) => void;
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

  const items = state.items.filter((i) => ctx.filter(i.name));
  if (items.length === 0 && !creating) {
    rows.push(
      <TreeRowNote key={`${dir}#0`} padLeft={notePad}>
        {state.items.length === 0 ? "（空目录）" : "没有匹配的项"}
      </TreeRowNote>,
    );
  }

  for (const item of items) {
    const full = joinPath(dir, item.name);
    if (ctx.editing && ctx.editing.mode === "rename" && ctx.editing.target?.toLowerCase() === full.toLowerCase()) {
      rows.push(<EditRow key={`rename-${full}`} ctx={ctx} />);
      continue;
    }
    if (item.isDir) {
      // 压缩中间包：`com → aier → erp` 只有一个子目录时合成一行 `com.aier.erp`
      const chain = collapseChain(full, item.name, ctx.dirs);
      const open = chainOpen(chain, ctx.expanded);
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
          parent={dir}
          onToggle={ctx.onToggle}
          onContextMenu={ctx.onContextMenu}
        />,
      );
      if (open) rows.push(<TreeRows key={`${chain.tail}-kids`} dir={chain.tail} depth={depth + 1} ctx={ctx} />);
    } else {
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
          padLeft={6 + depth * 14 + 20}
          onOpen={ctx.onActivate}
          onPin={ctx.onPin}
          onContextMenu={ctx.onContextMenu}
        />,
      );
    }
  }
  return <>{rows}</>;
}
