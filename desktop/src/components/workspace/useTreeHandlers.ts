import { useMemo, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

/**
 * 行组件的回调外壳。
 *
 * 行组件是 `memo` 的，所以传给它们的回调必须**身份稳定**。直接传 `() => …`
 * 等于每次渲染都换一批 prop，`memo` 一次也命中不了；而在 `useCallback` 上挂全量
 * 依赖又会随 `dirs/expanded` 每变一次就换一次身份。
 *
 * 做法是 ref 里存最新实现、外层给一次性外壳——行组件拿到的是稳定引用，调用的
 * 永远是当前闭包。
 */
export function useTreeHandlers(impl: {
  toggleRow: (path: string, parent: string | null) => void;
  toggle: (path: string) => void;
  onOpen: (path: string) => void;
  onPin?: (path: string) => void;
  openMenu: (e: ReactMouseEvent, path: string, isDir: boolean) => void;
  commitEdit: (value: string) => Promise<void>;
  cancelEdit: () => void;
  setSelected: (value: { path: string; isDir: boolean } | null) => void;
  isEditable: (path: string) => boolean;
}) {
  const latest = useRef(impl);
  latest.current = impl;
  // 点目录行除了展开/收起，也要把它变成「当前选中行」：F2 / Del / 标题栏「新建」
  // 全都读 `selected`，不跟着走就会作用在上一次选中的项上——在 A 目录上按 F2，
  // 结果改的是前面点过的 B。文件行由 `onActivate` 负责，这里补目录那两路。
  const select = (path: string, isDir: boolean) => latest.current.setSelected({ path, isDir });
  return useMemo(
    () => ({
      onToggle: (tail: string, parent: string) => {
        select(tail, true);
        latest.current.toggleRow(tail, parent);
      },
      onProjectToggle: (path: string) => {
        select(path, true);
        latest.current.toggle(path);
      },
      onActivate: (path: string) => {
        latest.current.setSelected({ path, isDir: false });
        latest.current.onOpen(path);
      },
      // 双击固定预览只对当前工程的文件有意义：别的工程还没打开，点了会先切工作区
      onPin: (path: string) => {
        if (latest.current.isEditable(path)) latest.current.onPin?.(path);
      },
      onContextMenu: (e: ReactMouseEvent, path: string, isDir: boolean) =>
        latest.current.openMenu(e, path, isDir),
      onCommitEdit: (v: string) => void latest.current.commitEdit(v),
      onCancelEdit: () => latest.current.cancelEdit(),
    }),
    [],
  );
}
