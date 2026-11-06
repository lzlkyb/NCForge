import type { ProblemMark } from "../../lib/compileMarks";
import type { InspectMark } from "../../lib/inspectMarks";

const compileTitle = (mark: ProblemMark): string => {
  const parts: string[] = [];
  if (mark.errors) parts.push(`${mark.errors} 个编译错误`);
  if (mark.warnings) parts.push(`${mark.warnings} 个编译警告`);
  return parts.join("，");
};

const inspectTitle = (mark: InspectMark): string => {
  const parts: string[] = [];
  if (mark.errors) parts.push(`${mark.errors} 个错误`);
  if (mark.warnings) parts.push(`${mark.warnings} 个警告`);
  if (mark.info) parts.push(`${mark.info} 个提示`);
  return `代码检查（jdt.ls）：${parts.join("，")}`;
};

/**
 * 树行 / 标签上的问题徽标。
 *
 * 编译问题与代码检查各占一个徽标：两者覆盖范围不同（ecj 整工程，jdt.ls 只看打开的
 * 文件），合成一个数字会让人以为列表里能逐条找到。tooltip 也分别写明来源。
 */
export function ProblemBadge({
  mark,
  inspect,
}: {
  mark?: ProblemMark;
  inspect?: InspectMark;
}) {
  const compile = mark && mark.errors + mark.warnings > 0 ? mark : null;
  const checked = inspect && inspect.total > 0 ? inspect : null;
  if (!compile && !checked) return null;
  return (
    <>
      {compile && (
        <span
          className="wb-problem-badge"
          data-sev={compile.errors > 0 ? "error" : "warning"}
          title={compileTitle(compile)}
          aria-label={compileTitle(compile)}
        >
          {compile.errors > 0
            ? compile.errors > 99
              ? "99+"
              : compile.errors
            : compile.warnings > 99
              ? "99+"
              : compile.warnings}
        </span>
      )}
      {checked && (
        <span
          className="wb-problem-badge"
          data-sev="inspect"
          title={inspectTitle(checked)}
          aria-label={inspectTitle(checked)}
        >
          {checked.total > 99 ? "99+" : checked.total}
        </span>
      )}
    </>
  );
}
