import type { ColumnInfo } from "../../lib/dbApi";
import { DATE_PRESETS, presetSample } from "../../lib/importDate";
import type { DateColumnInfo } from "../../hooks/useImportSource";

/** 列映射网格：文件列 → 目标列。纯渲染 + 回调，状态都在 `useImportSource`
 *  （`map` / `dupTarget` / 日期格式）。抽成独立文件是为了给「取消导入」的反馈腾出
 *  对话框主体的行数与 hook 额度（组件体量门禁：300 行 / 8 个 useState+useEffect）。
 *
 *  **对错只在这里决定**：映射错了不会报错，只会把文件名写进日期列。所以
 *  自动匹配（`lib/csvParse::autoMap`）只认「看起来就是同一列」的，其余留给用户手点。
 *
 *  日期列多一行格式选择：斜杠日期（`2026/11/17`）不定格式就会走 Oracle 的 NLS 隐式
 *  转换，`01/02/2026` 这类还会静默解析成另一个日期。歧义时不许导，必须先选。
 */
export function MapGrid({ headers, samples, map, cols, onChange, dupTarget, dateInfo, fmt, onFmt }: {
  headers: string[];
  /** 前若干行数据（只用来给人看样例）。 */
  samples: string[][];
  map: number[];
  cols: ColumnInfo[];
  onChange: (v: number, i: number) => void;
  dupTarget: boolean;
  /** 目标列下标 → 日期格式推断结果；非日期列不在表里。 */
  dateInfo: Record<number, DateColumnInfo>;
  /** 目标列下标 → 用户显式选的格式键。 */
  fmt: Record<number, string>;
  onFmt: (to: number, id: string) => void;
}) {
  return (
    <>
      <div className="dbx-maphd">列映射</div>
      <div className="dbx-mapgrid">
        <div className="h">文件列</div>
        <div className="h">样例（前 {samples.length} 行）</div>
        <div className="h">写入表的列</div>
        {headers.map((h, i) => {
          const to = map[i] ?? -1;
          return (
            <MapRow
              key={`${h}:${i}`}
              head={h || `第 ${i + 1} 列`}
              samples={samples.map((r) => r[i] ?? "")}
              value={to}
              cols={cols}
              onChange={(v) => onChange(v, i)}
              info={to >= 0 ? dateInfo[to] : undefined}
              chosen={to >= 0 ? fmt[to] : undefined}
              onFmt={(id) => onFmt(to, id)}
            />
          );
        })}
      </div>
      {dupTarget && <div className="dbx-err" style={{ marginTop: 6 }}>同一目标列被映射了两次，改一下再导</div>}
    </>
  );
}

/** 一行映射：文件列名 + 样例值 + 目标列下拉（日期列再加一行格式选择）。 */
function MapRow({ head, samples, value, cols, onChange, info, chosen, onFmt }: {
  head: string;
  samples: string[];
  value: number;
  cols: ColumnInfo[];
  onChange: (v: number) => void;
  info?: DateColumnInfo;
  chosen?: string;
  onFmt: (id: string) => void;
}) {
  const auto = info?.id ? presetSample(info.id) : null;
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
      {info && (
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, alignItems: "center", padding: "2px 0 4px 8px", fontSize: 11 }}>
          <span className="dbx-muted">日期格式</span>
          {/* 固定宽度：`.dbx-mapgrid select` 是 width:100%（给目标列下拉用的），
              在 flex 行里会把后面的说明文字整个挤出去 */}
          <select style={{ width: 180, flexShrink: 0 }} value={chosen ?? ""} onChange={(e) => onFmt(e.target.value)}>
            {/* 空值 = 交给推断：唯一命中就用它，判不出来就按原值写入 */}
            <option value="">{info.needsChoice ? "自动（判不出来）" : `自动（${auto ?? "按原样"}）`}</option>
            {DATE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.sample}</option>
            ))}
          </select>
          {info.needsChoice ? (
            <span style={{ color: "hsl(var(--warning-ink))" }}>既可能是「日/月/年」也可能是「月/日/年」，必须选一个才能导</span>
          ) : (
            <span className="dbx-muted">{auto ? `按 ${auto} 解析` : "值不像标准日期，将按原样写入"}</span>
          )}
        </div>
      )}
    </>
  );
}
