import { Icon } from "../ui/icon";
import { guessTable } from "../../lib/resultExport";

export interface ResultPaneOption { id: string; index: number; sql: string; startLine?: number }
export function ResultPaneHeading({ result, options, onPick, onLocate }: {
  result: ResultPaneOption; options?: ResultPaneOption[]; onPick?: (id: string) => void; onLocate?: (line: number) => void;
}) {
  const table = guessTable(result.sql);
  return <header className="dbx-result-pane-heading">
    {options && onPick ? <select aria-label={`替换查询 ${result.index} 结果`} value={result.id} onChange={event => onPick(event.target.value)}>
      {options.map(option => <option key={option.id} value={option.id}>查询 {option.index}{guessTable(option.sql) ? ` · ${guessTable(option.sql)}` : ""}</option>)}
    </select> : <strong>查询 {result.index}</strong>}
    {table && !options && <span className="dbx-result-pane-table" title={table}>{table}</span>}
    {onLocate && <button type="button" className="dbx-lk" title={result.sql} onClick={() => onLocate(result.startLine ?? 1)}><Icon name="code" size={13} />第 {result.startLine ?? 1} 行</button>}
  </header>;
}
