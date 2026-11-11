import { Icon } from "../ui/icon";
import { guessTable } from "../../lib/resultExport";

export interface ResultPaneOption { id: string; index: number; sql: string; startLine?: number }
export function ResultPaneHeading({ result, options, onPick, onLocate }: {
  result: ResultPaneOption; options: ResultPaneOption[]; onPick: (id: string) => void; onLocate?: (line: number) => void;
}) {
  return <header className="dbx-result-pane-heading">
    <select aria-label={`替换查询 ${result.index} 结果`} value={result.id} onChange={event => onPick(event.target.value)}>
      {options.map(option => <option key={option.id} value={option.id}>查询 {option.index}{guessTable(option.sql) ? ` · ${guessTable(option.sql)}` : ""}</option>)}
    </select>
    {onLocate && <button type="button" className="dbx-ibtn" aria-label={`定位 SQL 第 ${result.startLine ?? 1} 行`} title={`定位 SQL 第 ${result.startLine ?? 1} 行`} onClick={() => onLocate(result.startLine ?? 1)}><Icon name="locateSql" size={14} /></button>}
  </header>;
}
