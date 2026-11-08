import { useId } from "react";
import type { useResultTransferDialog } from "../../hooks/useResultTransferDialog";
import type { TransferFormat } from "../../lib/resultTransfer";
import { builtinTransferPresets } from "../../lib/resultTransferPresets";
import { Icon } from "../ui/icon";

export const transferFormats: { value: TransferFormat; label: string }[] = [
  { value: "xlsx", label: "Excel 工作簿 · XLSX" }, { value: "tsv", label: "制表符文本 · TSV" },
  { value: "csv", label: "逗号分隔 · CSV" }, { value: "json", label: "JSON 对象数组" },
  { value: "jsonl", label: "JSONL · 一行一条记录" }, { value: "markdown", label: "Markdown 表格" },
  { value: "html", label: "HTML 表格" }, { value: "insert", label: "SQL · INSERT" },
  { value: "where", label: "SQL · IN / WHERE 条件" }, { value: "update", label: "SQL · UPDATE" },
];
type Controller = ReturnType<typeof useResultTransferDialog>;
export function TransferPresets({ controller: c }: { controller: Controller }) {
  const s = c.state, id = useId();
  return <><div className="dbx-transfer-presets"><label htmlFor={`${id}-preset`}>常用预设</label><select id={`${id}-preset`} value={s.preset} onChange={e => e.target.value ? c.applyPreset(Number(e.target.value)) : c.patch({ preset: "" })}><option value="">自定义</option>{[...builtinTransferPresets, ...s.presets].map((p, i) => <option value={i} key={`${p.name}:${i}`}>{p.name}</option>)}</select><button type="button" className="dbx-ibtn" title="保存为预设" aria-label="保存为预设" onClick={() => c.patch({ savingPreset: !s.savingPreset })}><Icon name="check" size={14} /></button></div>
    {s.savingPreset && <div className="dbx-transfer-save-preset"><label htmlFor={`${id}-name`}>预设名称</label><input id={`${id}-name`} value={s.presetName} maxLength={40} onChange={e => c.patch({ presetName: e.target.value })} /><button type="button" className="dbx-btn" onClick={c.savePreset}>保存</button></div>}</>;
}
export function TransferFormatFields({ controller: c, mode, columns }: { controller: Controller; mode: "copy" | "file"; columns: { name: string }[] }) {
  const { state: s, opt } = c, o = s.options, text = ["csv", "tsv"].includes(o.format), sql = ["insert", "update", "where"].includes(o.format);
  return <section className="dbx-transfer-group"><h3>输出格式</h3><label className="dbx-transfer-field">格式<select aria-label="输出格式" value={o.format} onChange={e => c.format(e.target.value as TransferFormat)}>{transferFormats.map(f => <option key={f.value} value={f.value} disabled={mode === "copy" && f.value === "xlsx"}>{f.label}</option>)}</select></label>
      <div className="dbx-transfer-tags">{(["xlsx", "json", "insert"] as const).map((format, i) => <button type="button" key={format} aria-pressed={o.format === format} disabled={mode === "copy" && format === "xlsx"} onClick={() => c.format(format)}>{["Excel", "JSON", "SQL"][i]}</button>)}</div>
      <p className="dbx-transfer-help">{o.format === "xlsx" ? "长主键与前导零按文本保留，超出精度的数值不会转成浮点数。" : o.format === "tsv" ? "按引用规则保留单元格内换行与制表符，可粘贴到 Excel / WPS。" : o.format === "json" || o.format === "jsonl" ? "高精度数值保留为字符串，NULL 与空字符串分别输出。" : sql ? "只生成脚本，不执行。请核对目标表、字段映射及定位条件。" : "预览显示实际格式规则；文件输出使用完整原始值。"}</p>
      {text && <div className="dbx-transfer-row"><label className="dbx-transfer-field">分隔符<select aria-label="分隔符" disabled={o.format === "tsv"} value={o.delimiter} onChange={e => opt("delimiter", e.target.value)}><option value=",">逗号 ,</option><option value=";">分号 ;</option><option value="\t">制表符</option><option value="|">竖线 |</option></select></label><label className="dbx-transfer-field">NULL 表示<select aria-label="NULL 表示" value={o.nullText} onChange={e => opt("nullText", e.target.value)}><option value="">空白</option><option value="\N">\N</option><option value="NULL">NULL</option></select></label></div>}
      {o.format === "json" && <label className="dbx-transfer-choice"><input type="checkbox" checked={o.jsonStructure === "columns"} onChange={e => opt("jsonStructure", e.target.checked ? "columns" : "objects")} /><span>保留原始列名结构<small>使用 {"{columns, rows}"}；对象模式会为重名字段生成唯一键</small></span></label>}
      {sql && <>
        {o.format !== "where" && <div className="dbx-transfer-row"><label className="dbx-transfer-field">目标表<input aria-label="目标表" value={o.table} onChange={e => opt("table", e.target.value)} placeholder="请输入目标表" /></label><label className="dbx-transfer-field">目标 Schema<input aria-label="目标 Schema" value={o.schema} onChange={e => opt("schema", e.target.value)} placeholder="留空只输出表名" /></label></div>}
        {o.format !== "insert" && <>{o.format === "update" && <div className="dbx-transfer-key-list"><span>定位列</span>{columns.map((col, i) => <label key={i}><input type="checkbox" checked={o.keys.includes(i)} onChange={e => { opt("keys", e.target.checked ? [...o.keys, i] : o.keys.filter(k => k !== i)); opt("keysConfirmed", false); }} />{col.name}</label>)}</div>}
          {o.format === "where" ? <><label className="dbx-transfer-field">条件模式<select aria-label="条件模式" value={o.condition} onChange={e => opt("condition", e.target.value as "in" | "notIn" | "where")}><option value="in">IN 列表</option><option value="notIn">NOT IN 列表</option><option value="where">多列 WHERE 条件</option></select></label><p className="dbx-transfer-help">在“调整输出列”中选择条件列；IN / NOT IN 使用一列，多列 WHERE 使用所有勾选列。</p><label className="dbx-transfer-choice"><input type="checkbox" checked={!!o.includeNull} onChange={e => opt("includeNull", e.target.checked)} /><span>条件显式处理空值<small>IN 匹配 NULL，NOT IN 排除 NULL；默认跳过并在摘要提示</small></span></label></> : <label className="dbx-transfer-choice"><input type="checkbox" checked={o.keysConfirmed} onChange={e => opt("keysConfirmed", e.target.checked)} /><span>已确认这些列是目标表的唯一键<small>UPDATE 附带读取时的键值及原值条件，缺键时不能生成</small></span></label>}
        </>}
        {o.format === "insert" && <label className="dbx-transfer-choice"><input type="checkbox" checked={o.nc} onChange={e => opt("nc", e.target.checked)} /><span>使用 NC 基础数据迁移入口<small>单独设置主键、多语规则、行数上限和提交策略</small></span></label>}
      </>}
      {o.nc && <p className="dbx-transfer-note">NC 迁移使用来源 SQL 和绑定参数独立查询，不使用网格选区、本地筛选或未保存修改；下一步单独复核行数与转换规则。</p>}
      {mode === "file" && o.format === "xlsx" && <label className="dbx-transfer-choice"><input type="checkbox" checked={o.includeQuery} onChange={e => opt("includeQuery", e.target.checked)} /><span>附加查询说明工作表<small>来源 SQL、连接来源和范围</small></span></label>}
    </section>;
}
export function TransferAdvancedFields({ controller: c, mode }: { controller: Controller; mode: "copy" | "file" }) {
  const { state: s, opt } = c, o = s.options, text = ["csv", "tsv"].includes(o.format), sql = ["insert", "update", "where"].includes(o.format);
  return <details className="dbx-transfer-advanced"><summary>高级设置与预设<Icon name="chevronDown" size={14} /></summary><div className="dbx-transfer-row"><label className="dbx-transfer-field">表头<select aria-label="输出表头" disabled={sql || ["json", "jsonl"].includes(o.format) || s.allSets} value={o.header} onChange={e => opt("header", e.target.value as TransferOptionsHeader)}><option value="name">数据库列名</option><option value="zh">中文名称</option><option value="both">列名与中文名</option><option value="none">不包含表头</option></select></label><label className="dbx-transfer-field">值来源<select aria-label="输出值来源" disabled={s.scope === "query" || s.allSets} value={s.edited ? "edited" : "original"} onChange={e => c.patch({ edited: e.target.value === "edited" })}><option value="original">查询原始值</option><option value="edited">包含未保存修改</option></select></label></div>
      {text && <><div className="dbx-transfer-row"><label className="dbx-transfer-field">文件编码<select value={o.bom ? "bom" : "utf8"} onChange={e => opt("bom", e.target.value === "bom")} disabled={mode === "copy"}><option value="bom">UTF-8 · 带 BOM</option><option value="utf8">UTF-8</option></select></label><label className="dbx-transfer-field">换行<select value={o.lineEnding} onChange={e => opt("lineEnding", e.target.value as "lf" | "crlf")}><option value="crlf">Windows · CRLF</option><option value="lf">LF</option></select></label></div><label className="dbx-transfer-choice"><input type="checkbox" checked={o.spreadsheetSafe} onChange={e => opt("spreadsheetSafe", e.target.checked)} /><span>适合表格软件<small>保留长代码并防止字符串被当成公式；关闭后输出原始文本</small></span></label></>}
      {(["csv", "tsv", "xlsx", "html", "markdown"].includes(o.format)) && <label className="dbx-transfer-choice"><input type="checkbox" checked={o.transpose} disabled={s.scope === "query" || s.allSets} onChange={e => opt("transpose", e.target.checked)} /><span>转置行列<small>{s.scope === "query" ? "全量流式查询不支持转置，可导出已加载结果" : "按所选表头和数据矩阵转置"}</small></span></label>}
      <div className="dbx-transfer-preset-settings"><TransferPresets controller={c} /></div>
    </details>;
}
type TransferOptionsHeader = "name" | "zh" | "both" | "none";
