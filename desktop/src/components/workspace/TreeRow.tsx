import { useContext, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { TreeSvnContext } from "./TreeSvnContext";
import { pathKey } from "../../lib/treeSvn";
import { Icon } from "../ui/icon";
import type { EncodingMark } from "../../lib/workspace";

/**
 * 文件树的一行。目录行与文件行分开：两者的选中/激活语义不同
 * （目录只有 data-selected，文件还有 data-active = 编辑器里正打开的那个）。
 */

export function TreeDirRow({
  name,
  path,
  open,
  selected,
  padLeft,
  onToggle,
  onContextMenu,
}: {
  name: string;
  path: string;
  open: boolean;
  selected: boolean;
  padLeft: number;
  onToggle: (path: string) => void;
  onContextMenu: (e: ReactMouseEvent, path: string, isDir: boolean) => void;
}) {
  const count = useContext(TreeSvnContext).directories.get(pathKey(path));
  return (
    <button
      type="button"
      className="wb-row"
      style={{ paddingLeft: padLeft }}
      data-selected={selected || undefined}
      onClick={() => onToggle(path)}
      onContextMenu={(e) => onContextMenu(e, path, true)}
      aria-expanded={open}
      title={name}
    >
      <Icon name="chevronDown" size={14} className={`wb-row-icon ${open ? "" : "-rotate-90"}`} />
      <Icon name="folder" size={14} className="wb-row-icon" />
      <span className="wb-row-name">{name}</span>
      {!!count && <span className="wb-svn-count" title={`${count} 个文件有 SVN 变更`}>{count}</span>}
    </button>
  );
}

export function TreeFileRow({
  name,
  path,
  active,
  selected,
  mark,
  padLeft,
  onOpen,
  onPin,
  onContextMenu,
}: {
  name: string;
  path: string;
  active: boolean;
  selected: boolean;
  mark: EncodingMark | undefined;
  padLeft: number;
  onOpen: (path: string) => void;
  /** 双击：把预览标签固定下来。 */
  onPin?: (path: string) => void;
  onContextMenu: (e: ReactMouseEvent, path: string, isDir: boolean) => void;
}) {
  const svn = useContext(TreeSvnContext).files.get(pathKey(path));
  return (
    <button
      type="button"
      className="wb-row"
      style={{ paddingLeft: padLeft }}
      data-active={active || undefined}
      data-selected={selected || undefined}
      onClick={() => onOpen(path)}
      onDoubleClick={() => onPin?.(path)}
      onContextMenu={(e) => onContextMenu(e, path, false)}
      title={mark ? `${name}\n${encodingHint(mark)}` : name}
    >
      <Icon name="file" size={14} className="wb-row-icon" />
      <span className="wb-row-name">{name}</span>
      {svn && <span className="wb-svn-mark" data-st={svn} title={`SVN：${({ M: "已修改", A: "新增", D: "已删除", "?": "未纳管", C: "冲突", "!": "缺失", R: "替换", G: "已合并", "~": "类型冲突" })[svn]}`}>{svn}</span>}
      {mark && (
        // 「UTF-8!」四个字要占 40 多像素，在六层目录下会把文件名挤成「Vouc…」。
        // 缩成 U8，完整说明放在行的 title 里。
        <span className="wb-enc-badge" title={encodingHint(mark)}>
          U8
        </span>
      )}
    </button>
  );
}

/** 树里的说明行：加载中 / 读取失败 / 空目录。 */
export function TreeRowNote({
  children,
  padLeft,
  tone,
  title,
}: {
  children: ReactNode;
  padLeft: number;
  tone?: "bad";
  title?: string;
}) {
  return (
    <div className="wb-row-note" data-tone={tone} style={{ paddingLeft: padLeft }} title={title}>
      {children}
    </div>
  );
}

/**
 * 树上 `UTF-8!` 的悬停说明：说清「为什么标」以及「谁的产物是对的」。
 * 用原生 title（多行用 \n 分隔），不值得为一行提示再写一套浮层。
 */
export function encodingHint(m: EncodingMark): string {
  const where = m.registered ? `登记为 ${m.registered}` : "没有登记";
  return [
    `这个文件是 UTF-8，但 Eclipse 编码偏好里${where}，Eclipse 会按工程默认的 GBK 读。`,
    "用 Eclipse 编译时，里面的中文字符串常量会变成乱码；NCForge 按 UTF-8 处理，产物是对的。",
  ].join("\n");
}
