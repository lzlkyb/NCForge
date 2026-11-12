import { Icon } from "../ui/icon";
import { statementTitle } from "../../lib/sqlStatementTitle";
import type { RunStmt } from "./SqlEditor";

/** 条数少的时候这条导航没有意义，反而多占 26px。 */
const MIN = 3;
/** 一次最多渲染多少条：几百条的脚本渲染出来也没人看，翻找靠滚动更慢。 */
const MAX = 80;

/**
 * 没有注释标题时的名字：去掉前导注释、压掉换行与多余空白，取前 N 个字。
 *
 * 取正文而不是「语句 3」：脚本里十条 `select count(*)` 长得一样，
 * 但 `select * from bd_material` 一眼能认出是哪一段。
 */
export function statementBrief(sql: string, max = 18): string {
  const body = sql
    .replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...body];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : body;
}

/**
 * 语句大纲：一条语句一个可点的位置，点了跳到它的首行。
 *
 * 刻意不做成左侧竖栏：SQL 控制台的横向空间已经给了结果区，竖栏会把编辑器压窄；
 * 横条只在多语句脚本（≥3 条）时出现，单条查询时完全不占位。
 */
export function SqlOutlineBar({ statements, onPick }: { statements: RunStmt[]; onPick: (line: number) => void }) {
  if (statements.length < MIN) return null;
  const shown = statements.slice(0, MAX);
  return (
    <div className="dbx-outline" role="navigation" aria-label="语句大纲">
      <Icon name="panel" size={12} className="dbx-outline-icon" />
      {shown.map((stmt, index) => {
        const title = statementTitle(stmt.text) ?? statementBrief(stmt.text);
        return (
          <button type="button" key={`${stmt.startLine}:${index}`} className="dbx-outline-item"
            title={`第 ${stmt.startLine} 行 · ${statementBrief(stmt.text, 80)}`}
            onClick={() => onPick(stmt.startLine)}>
            <span className="dbx-outline-no">{index + 1}</span>{title || "（空语句）"}
          </button>
        );
      })}
      {statements.length > MAX && <span className="dbx-outline-more">还有 {statements.length - MAX} 条</span>}
    </div>
  );
}
