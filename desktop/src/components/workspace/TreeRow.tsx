import { memo, useContext, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { TreeSvnContext } from "./TreeSvnContext";
import { treeFileKind, type JavaTreeKind } from "../../lib/treeFileKind";
import { pathKey } from "../../lib/treeSvn";
import { WorkspaceGlyph } from "./WorkspaceGlyph";
import { TreeTypeMarker } from "./TreeTypeMarker";
import { ProblemBadge } from "./ProblemBadge";
import { WorkspaceFileName } from "./WorkspaceFileName";
import type { EncodingMark } from "../../lib/workspace";
import type { ProblemMark } from "../../lib/compileMarks";
import type { InspectMark } from "../../lib/inspectMarks";

/**
 * 文件树的一行。目录行与文件行分开：两者的选中/激活语义不同
 * （目录只有 data-selected，文件还有 data-active = 编辑器里正打开的那个）。
 *
 * **全部 `memo`**：光标在编辑器里移动、编译状态翻转、SVN 徽标刷新这些都不该
 * 让几百上千行重渲染。props 全是原始值，`FileTree` 那边把回调做成了稳定引用
 * （`handlers` 的一次性外壳 + ref 取最新实现），所以比较真的能命中。
 */

/**
 * 多工程树里的工程根行。
 *
 * 当前工程带「当前」标记：编译 / SVN / 搜索（当前范围）都只作用于它，
 * 别的工程是可浏览、只读的——点文件会先问要不要切换工作区。
 */
export const TreeProjectRow = memo(function TreeProjectRow({
  name,
  path,
  id,
  level,
  open,
  selected,
  current,
  badge,
  problem,
  inspect,
  onToggle,
  onContextMenu,
}: {
  name: string;
  path: string;
  id: string;
  level: number;
  open: boolean;
  selected: boolean;
  current: boolean;
  /** 非当前工程显示来路（依赖 / 已提前 / 无 .classpath）；当前工程显示「当前」。 */
  badge: string;
  /** 当前工程根下（含更深层）的编译问题合计。 */
  problem?: ProblemMark;
  /** jdt.ls 代码检查（只覆盖打开的文件）；与编译问题分开计数。 */
  inspect?: InspectMark;
  onToggle: (path: string) => void;
  onContextMenu: (e: ReactMouseEvent, path: string, isDir: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="wb-row wb-row-project"
      data-kind="project"
      id={id}
      role="treeitem"
      tabIndex={-1}
      aria-level={level}
      aria-selected={selected}
      aria-expanded={open}
      data-current={current || undefined}
      data-selected={selected || undefined}
      onClick={() => onToggle(path)}
      onContextMenu={(e) => onContextMenu(e, path, true)}
      title={
        current
          ? `${path}\n当前工程：编译 / SVN 作用于它`
          : `${path}\n关联工程：只读浏览，写操作请先切换工作区`
      }
    >
      <WorkspaceGlyph name={open ? "down" : "right"} size={14} className="wb-row-icon wb-row-disclosure" />
      <WorkspaceGlyph name="project" tone="slate" />
      <span className="wb-row-name">{name}</span>
      <span className="wb-project-badge" data-current={current || undefined}>
        {badge}
      </span>
      <ProblemBadge mark={problem} inspect={inspect} />
    </button>
  );
});

export const TreeDirRow = memo(function TreeDirRow({
  name,
  path,
  id,
  level,
  open,
  selected,
  padLeft,
  parent,
  bc,
  sourceRoot,
  packageDir,
  problem,
  inspect,
  onToggle,
  onContextMenu,
}: {
  name: string;
  path: string;
  /** 树容器的 `aria-activedescendant` 指向它。 */
  id: string;
  level: number;
  open: boolean;
  selected: boolean;
  padLeft: number;
  /** 这一行所在的目录：展开/收起要连父目录一起看（压缩链）。 */
  parent: string;
  /** 业务组件名（`manifest.xml` 登记过才有）：非空时目录后面打 BC 徽章。 */
  bc?: string;
  sourceRoot?: boolean;
  packageDir?: boolean;
  /** 这个目录下（含更深层）的编译问题合计。 */
  problem?: ProblemMark;
  /** jdt.ls 代码检查（只覆盖打开的文件）；与编译问题分开计数。 */
  inspect?: InspectMark;
  onToggle: (path: string, parent: string) => void;
  onContextMenu: (e: ReactMouseEvent, path: string, isDir: boolean) => void;
}) {
  const count = useContext(TreeSvnContext).directories.get(pathKey(path));
  const testRoot = sourceRoot && /(?:^|[\\/])test$/i.test(path);
  const kind = sourceRoot ? "source" : packageDir ? "package" : "folder";
  const split = sourceRoot ? name.indexOf("/") : packageDir ? name.lastIndexOf(".") + 1 : 0;
  return (
    <button
      type="button"
      className="wb-row"
      data-kind={kind}
      id={id}
      role="treeitem"
      tabIndex={-1}
      aria-level={level}
      aria-selected={selected}
      style={{ "--wb-tree-pad": `${padLeft}px` } as CSSProperties}
      data-selected={selected || undefined}
      onClick={() => onToggle(path, parent)}
      onContextMenu={(e) => onContextMenu(e, path, true)}
      aria-expanded={open}
      aria-label={sourceRoot || packageDir ? name : undefined}
      aria-description={testRoot ? "测试源码根" : undefined}
      title={sourceRoot ? path : name}
    >
      <WorkspaceGlyph name={open ? "down" : "right"} size={14} className="wb-row-icon wb-row-disclosure" />
      <WorkspaceGlyph name={sourceRoot ? "source" : packageDir ? "package" : "folder"} tone={sourceRoot ? "teal" : "slate"} />
      <span className="wb-row-name" data-split={split > 0 || undefined}>
        {split > 0 ? <><span className="wb-row-prefix">{name.slice(0, split)}</span><span className="wb-row-tail">{name.slice(split)}</span></> : name}
      </span>
      {testRoot && <span className="wb-tree-test-badge" title="测试源码根" aria-hidden="true">T</span>}
      <ProblemBadge mark={problem} inspect={inspect} />
      {bc && (
        // 两个字母足够区分：满屏 60 个模块里，「哪些是 manifest 登记的业务组件」是
        // 唯一需要一眼看出的信息，完整说明放 title。
        <span
          className="wb-bc-badge"
          title={`业务组件：${bc}\n由工程根的 manifest.xml（BusinessComponet）登记`}
        >
          BC
        </span>
      )}
      {!!count && <span className="wb-svn-count" title={`${count} 个文件有 SVN 变更`}>{count}</span>}
    </button>
  );
});

export const TreeFileRow = memo(function TreeFileRow({
  name,
  path,
  id,
  level,
  active,
  selected,
  mark,
  javaKind,
  problem,
  inspect,
  memberExpanded,
  onToggleMembers,
  bookmarks,
  padLeft,
  onOpen,
  onPin,
  onContextMenu,
}: {
  name: string;
  path: string;
  id: string;
  level: number;
  active: boolean;
  selected: boolean;
  mark: EncodingMark | undefined;
  javaKind?: JavaTreeKind;
  /** 这个文件自己的编译问题。 */
  problem?: ProblemMark;
  /** jdt.ls 代码检查（只覆盖打开的文件）；与编译问题分开计数。 */
  inspect?: InspectMark;
  memberExpanded?: boolean;
  onToggleMembers?: (path: string) => void;
  /** 这个文件里的书签条数（0 = 不打点）。 */
  bookmarks: number;
  padLeft: number;
  onOpen: (path: string) => void;
  /** 双击：把预览标签固定下来。 */
  onPin?: (path: string) => void;
  onContextMenu: (e: ReactMouseEvent, path: string, isDir: boolean) => void;
}) {
  const svn = useContext(TreeSvnContext).files.get(pathKey(path));
  const kind = treeFileKind(name, javaKind);
  return (
    <button
      type="button"
      className="wb-row"
      data-file
      data-kind={kind.id}
      id={id}
      role="treeitem"
      tabIndex={-1}
      aria-level={level}
      aria-selected={selected}
      aria-current={active || undefined}
      aria-expanded={memberExpanded}
      aria-label={name}
      aria-description={kind.label}
      style={{ "--wb-tree-pad": `${padLeft}px` } as CSSProperties}
      data-active={active || undefined}
      data-selected={selected || undefined}
      onClick={() => onOpen(path)}
      onDoubleClick={() => onPin?.(path)}
      onContextMenu={(e) => onContextMenu(e, path, false)}
      title={`${name} · ${kind.label}${mark ? `\n${encodingHint(mark)}` : ""}`}
    >
      {onToggleMembers && <span className="wb-file-disclosure" title={memberExpanded ? "收起 Java 成员" : "展开 Java 成员"}
        onClick={e => { e.stopPropagation(); onToggleMembers(path); }} onDoubleClick={e => e.stopPropagation()}>
        <WorkspaceGlyph name={memberExpanded ? "down" : "right"} size={12} />
      </span>}
      <TreeTypeMarker kind={kind} />
      <WorkspaceFileName name={name} className="wb-row-name" />
      <ProblemBadge mark={problem} inspect={inspect} />
      {svn && <span className="wb-svn-mark" data-st={svn} title={`SVN：${({ M: "已修改", A: "新增", D: "已删除", "?": "未纳管", C: "冲突", "!": "缺失", R: "替换", G: "已合并", "~": "类型冲突" })[svn]}`}>{svn}</span>}
      {bookmarks > 0 && (
        <span
          className="wb-bookmark-mark"
          title={`${bookmarks} 条书签（F11 在光标处加/去）`}
        />
      )}
      {mark && (
        // 「UTF-8!」四个字要占 40 多像素，在六层目录下会把文件名挤成「Vouc…」。
        // 缩成 U8，完整说明放在行的 title 里。
        <span className="wb-enc-badge" title={encodingHint(mark)}>
          U8
        </span>
      )}
    </button>
  );
});

/** 树里的说明行：加载中 / 读取失败 / 空目录。 */
export const TreeRowNote = memo(function TreeRowNote({
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
});

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
