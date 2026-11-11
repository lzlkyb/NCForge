import { CodePreview } from "./CodePreview";
import { serializeTransfer, transferJsonKeys, type TransferOptions, type TransferData } from "../../lib/resultTransfer";
import { Icon } from "../ui/icon";
import { CELL_TEXT_MAX } from "../../lib/wideText";

export function TransferPreview({ data, options: o, order, onColumns, onMove, query, disabled, summary }: {
  data: TransferData; options: TransferOptions; order: number[]; onColumns: (indices: number[]) => void;
  onMove: (index: number, direction: number) => void; query: boolean; disabled?: boolean; summary?: string;
}) {
  const selected = o.columnIndices;
  // 与结果网格共用同一个「长文本」上限：两处各写一个 300 迟早会漂。
  const clipped = data.rows.slice(0, 10).some(r => r.some(v => typeof v === "string" && v.length > CELL_TEXT_MAX));
  const sql=["insert","where","update"].includes(o.format);
  const full={...data,rows:data.rows.slice(0,10),originalRows:data.originalRows?.slice(0,10)};
  // SQL compares current and original keys. Abbreviating inputs can invent a key change.
  const sample = sql ? full : { ...full, rows: full.rows.map(r => r.map(v => typeof v === "string" && v.length > CELL_TEXT_MAX ? `${v.slice(0, CELL_TEXT_MAX)}…` : v)) };
  const largeSql=sql && [...full.rows,...(full.originalRows ?? [])].reduce((sum,r)=>sum+r.reduce<number>((n,v)=>n+(typeof v==="string" ? v.length : 16),0),0)>500000;
  let text = "";
  try { if (selected.length && o.format !== "xlsx") text = largeSql ? "样本含超大文本，SQL 预览已暂停；复制或文件导出保留完整值。" : serializeTransfer(sample, o); }
  catch (error) { text = error instanceof Error ? error.message : String(error); }
  const textClipped=sql && text.length>20000;
  if(textClipped) text=text.slice(0,20000)+"\n…（预览省略后续文本）";
  const duplicates = new Set(selected.map(i => data.columns[i].name)).size !== selected.length;
  const labels = selected.map(i => o.columnLabels[i] || data.columns[i].name);
  const headers = o.header === "none" ? [] : o.header === "both" ? [selected.map(i => data.columns[i].name), labels] : [o.header === "zh" ? labels : selected.map(i => data.columns[i].name)];
  let matrix = [...headers, ...sample.rows.map(r => selected.map(i => r[i]))];
  if (o.transpose) matrix = matrix[0]?.map((_, i) => matrix.map(r => r[i])) ?? [];
  return <div className="dbx-transfer-preview" tabIndex={-1} role="region" aria-label="输出预览与字段">
    <div className="dbx-transfer-preview-head"><div><h3>输出预览</h3>{summary && <p className="dbx-transfer-preview-scope">{summary}</p>}</div><span className="dbx-transfer-preview-format">{o.format.toUpperCase()}</span></div>
    <div className="dbx-transfer-preview-sample">样本 {Math.min(10, data.rows.length)} 行 × {selected.length} 列{disabled ? " · 当前结果集" : o.format === "xlsx" ? " · 工作表 1" : ""}</div>
    <div className="dbx-transfer-preview-data" tabIndex={0} role="region" aria-label="预览内容">{!selected.length ? <p className="dbx-transfer-preview-empty">请选择至少一个输出字段。</p> : o.format === "xlsx" ? <table aria-label="Excel 输出预览"><tbody>{matrix.map((r, i) => <tr key={i}>{r.map((v, j) => i < headers.length && !o.transpose ? <th key={j}>{String(v)}</th> : <td key={j} title={String(v ?? "NULL")} className={v === null ? "null" : ""}>{String(v ?? o.nullText)}</td>)}</tr>)}</tbody></table> : <pre aria-label="输出文本预览">{text}</pre>}</div>
    <p className="dbx-transfer-help">{query ? "当前结果样本，重新查询的数据可能变化。" : disabled ? "各结果集分别保留全部字段，此处仅预览当前结果集的前 10 行。" : "预览前 10 行，输出使用所选范围的全部记录。"}{clipped && !sql && " 长值预览最多 300 字，文件保留原值。"}{textClipped && " SQL 只展示前 20000 字，复制与导出使用完整脚本。"}</p>
    {duplicates && ["json", "jsonl"].includes(o.format) && o.jsonStructure === "objects" && <p className="dbx-transfer-note">重名键已映射为：{transferJsonKeys(selected.map(i => data.columns[i])).join("、")}，也可选择保留原始列名结构。</p>}
    {o.format === "xlsx" && <p className="dbx-transfer-note">长主键、前导零和超出 15 位精度的数值按文本保留；字符串不会作为公式执行。</p>}
    <details className="dbx-transfer-column-settings"><summary><span>调整输出列</span><span className="dbx-transfer-column-count">{selected.length} / {data.columns.length} 列</span><Icon name="chevronDown" size={14} /></summary>
    <div className="dbx-transfer-cols-title"><h3>输出字段</h3><button type="button" className="dbx-btn ghost" disabled={disabled} onClick={() => onColumns([...order])}>全部列</button></div>
    <div className="dbx-transfer-cols">{order.map((i, position) => <div className="dbx-transfer-col" key={i}><label><input type="checkbox" disabled={disabled} checked={selected.includes(i)} onChange={e => onColumns(e.target.checked ? order.filter(c => selected.includes(c) || c === i) : selected.filter(c => c !== i))} /><span><code>{data.columns[i].name}</code><small>{o.columnLabels[i]}</small></span></label><span className="dbx-transfer-type">{data.columns[i].type}</span><button type="button" className="dbx-ibtn" disabled={disabled || !position} aria-label={`上移 ${data.columns[i].name}`} onClick={() => onMove(i, -1)}><Icon name="arrowUp" size={12} /></button><button type="button" className="dbx-ibtn" disabled={disabled || position === order.length - 1} aria-label={`下移 ${data.columns[i].name}`} onClick={() => onMove(i, 1)}><Icon name="chevronDown" size={12} /></button></div>)}</div>
    <p className="dbx-transfer-help">{disabled ? "全部结果集分别保留各自的全部字段，此处展示当前结果集样本。" : "未勾选字段不会导出；上移、下移调整输出顺序。"}</p>
    </details>
    {data.query && <details className="dbx-transfer-source-query"><summary>来源 SQL</summary><CodePreview text={data.query} label="导出来源 SQL"/></details>}
  </div>;
}
