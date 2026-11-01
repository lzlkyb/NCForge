import type { ColumnInfo } from "../../lib/dbApi";

/** 列映射网格：文件列 → 目标列。纯渲染 + 回调，状态都在 `ImportDialog`（`map` /
 *  `dupTarget`）。抽成独立文件是为了给「取消导入」的反馈腾出对话框主体的
 *  行数与 hook 额度（组件体量门禁：300 行 / 8 个 useState+useEffect）。
 *
 *  **对错只在这里决定**：映射错了不会报错，只会把文件名写进日期列。所以
 *  自动匹配（`lib/csvParse::autoMap`）只认「看起来就是同一列」的，其余留给用户手点。
 */
export function MapGrid({ headers, samples, map, cols, onChange, dupTarget }: {
  headers: string[];
  /** 前若干行数据（只用来给人看样例）。 */
  samples: string[][];
  map: number[];
  cols: ColumnInfo[];
  onChange: (v: number, i: number) => void;
  dupTarget: boolean;
}) {
  return (
    <>
      <div className="dbx-maphd">列映射</div>
      <div className="dbx-mapgrid">
        <div className="h">文件列</div>
        <div className="h">样例（前 {samples.length} 行）</div>
        <div className="h">写入表的列</div>
        {headers.map((h, i) => (
          <MapRow
            key={`${h}:${i}`}
            head={h || `第 ${i + 1} 列`}
            samples={samples.map((r) => r[i] ?? "")}
            value={map[i] ?? -1}
            cols={cols}
            onChange={(v) => onChange(v, i)}
          />
        ))}
      </div>
      {dupTarget && <div className="dbx-err" style={{ marginTop: 6 }}>同一目标列被映射了两次，改一下再导</div>}
    </>
  );
}

/** 一行映射：文件列名 + 样例值 + 目标列下拉。 */
function MapRow({ head, samples, value, cols, onChange }: {
  head: string;
  samples: string[];
  value: number;
  cols: ColumnInfo[];
  onChange: (v: number) => void;
}) {
  return (
    <>
      <div className="dbx-mono">{head}</div>
      <div className="dbx-mapcell">
        {samples.map((s, i) => (
          <span key={i} className="dbx-mono">{s === "" ? <span className="dbx-muted">（空）</span> : s}</span>
        ))}
      </div>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        <option value={-1}>（不导入这一列）</option>
        {cols.map((c, i) => (
          <option key={c.name} value={i}>
            {c.name.toLowerCase()} · {c.full}
          </option>
        ))}
      </select>
    </>
  );
}
