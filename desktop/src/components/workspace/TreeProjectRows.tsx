import { Fragment } from "react";
import { TreeProjectRow } from "./TreeRow";
import { TreeRows, type TreeRowsCtx } from "./TreeRows";
import { originLabel, type LinkedProject } from "../../lib/linkedProjects";
import { baseName } from "../../lib/workspace";
import { treeRowId as rowId } from "../../lib/treeNav";
import { inspectMarkOf, useInspectMarks } from "../../lib/inspectMarks";
import { useCompileMarks } from "../../hooks/useCompileMarks";
import { markOf } from "../../lib/compileMarks";

const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function badgeOf(p: LinkedProject, root: string): string {
  if (p.root && samePath(p.root, root)) return "当前";
  if (p.disabled) return "已停用";
  return originLabel(p.origin);
}

/**
 * 多工程树的顶层：每个关联工程各占一行，展开后才是它的目录。
 *
 * 从 `FileTree` 抽出来是为了守住 300 行门禁；这里只有「工程行 + 递归子树」，
 * 菜单、键盘、自动定位仍归 `FileTree`。
 */
export function TreeProjectRows({
  projects,
  root,
  ctx,
}: {
  projects?: LinkedProject[];
  /** 当前工作区根：决定哪一行带「当前」标记。 */
  root: string;
  ctx: TreeRowsCtx;
}) {
  const inspectMarks = useInspectMarks();
  const rows = projects?.flatMap(p => p.root ? [{ path: p.root, name: p.name, badge: badgeOf(p, root) }] : []) ?? [];
  if (!rows.length) rows.push({ path: root, name: baseName(root) || root, badge: "当前" });
  const marks = useCompileMarks();
  return (
    <>
      {rows.map(({ path, name, badge }) => (
        <Fragment key={path}>
          <TreeProjectRow
            name={name}
            path={path}
            id={rowId(path)}
            level={1}
            open={ctx.expanded.has(path)}
            selected={ctx.selectedPath === path}
            current={samePath(path, root)}
            badge={badge}
            problem={markOf(marks, path)}
            inspect={inspectMarkOf(inspectMarks, path)}
            onToggle={ctx.onProjectToggle}
            onContextMenu={ctx.onContextMenu}
          />
          {ctx.expanded.has(path) && <TreeRows dir={path} depth={1} ctx={ctx} />}
        </Fragment>
      ))}
    </>
  );
}
