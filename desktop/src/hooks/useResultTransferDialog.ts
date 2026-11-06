import { useRef, useState } from "react";
import { defaultTransferOptions, validateTransfer, transferExtension, type TransferOptions, type TransferFormat } from "../lib/resultTransfer";
import { scopeIndices, scopedTransferData, selectionIndices, transferCanRequery, transferScopeLabel, type TransferFrame, type TransferScope, type TransferDialogSeed } from "../lib/resultTransferContext";
import { copyTransfer } from "../lib/resultTransferClipboard";
import { dbTransferApi, type TransferDestination } from "../lib/dbTransferApi";
import { startTransferJob } from "../lib/resultTransferJobs";
import { builtinTransferPresets, lastTransferFormat, rememberTransferFormat, readTransferPresets, saveTransferPreset } from "../lib/resultTransferPresets";
import { toast } from "../components/ui/toast";

export type { TransferDialogSeed } from "../lib/resultTransferContext";
function stamp() { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`; }
export function useResultTransferDialog(frame: TransferFrame, mode: "copy" | "file", seed?:TransferDialogSeed) {
  const initial = () => {
    const last=lastTransferFormat(mode), options = {...defaultTransferOptions(last.format),header:last.header};
    options.table = frame.source.table === "表名" ? "" : frame.source.table ?? "";
    options.columnIndices = [...selectionIndices(frame)]; options.columnLabels = frame.labels;
    options.keys = (frame.source.keys ?? []).map(k => frame.data.columns.findIndex(c => c.name.toUpperCase() === k.toUpperCase())).filter(i => i >= 0);
    options.keysConfirmed = !!options.keys.length;
    if(seed) Object.assign(options,seed.options);
    return { options, scope: seed?.scope ?? (frame.selection ? "selection" as TransferScope : "filtered" as TransferScope),
      edited: seed?.edited ?? false, columnOrder: seed?.columnOrder ?? [...frame.visible, ...frame.data.columns.map((_, i) => i).filter(i => !frame.visible.includes(i))],
      fileName: seed?.fileName ?? `${options.table || "查询结果"}-${stamp()}.${transferExtension(options.format)}`, destination: (seed?.destination ?? null) as TransferDestination | null,
      busy: "" as "" | "pick" | "copy", error: "", notice:"", ncOpen: false, allSets: seed?.allSets ?? false, presets: readTransferPresets(), preset: "", presetName: "", savingPreset: false };
  };
  const [state, set] = useState(initial);
  const lock = useRef(false);
  const patch = (value: Partial<typeof state>) => set(s => ({ ...s, ...value, ...(value.fileName !== undefined ? { destination: null } : {}) }));
  const allSets = (value: boolean) => set(s => ({ ...s, allSets: value, scope: "loaded", edited: false, columnOrder:frame.data.columns.map((_,i)=>i), options: { ...s.options, columnIndices: frame.data.columns.map((_,i)=>i), header: "name", transpose: false }, error: "" }));
  const opt = <K extends keyof TransferOptions>(key: K, value: TransferOptions[K]) => set(s => ({ ...s, error: "", preset: "", options: { ...s.options, [key]: value } }));
  const format = (value: TransferFormat) => set(s => ({ ...s, allSets: value === "xlsx" && s.allSets, destination: null, error: "",
    fileName: s.fileName.replace(/\.[^.]+$/, `.${transferExtension(value)}`),
    options: { ...s.options, format: value, nc: false, delimiter: value === "tsv" ? "\t" : s.options.delimiter === "\t" ? "," : s.options.delimiter,
      transpose: ["tsv", "csv", "markdown", "html", "xlsx"].includes(value) && s.options.transpose } }));
  const scope = (value: TransferScope) => set(s => ({ ...s, scope: value, allSets: false, error: "", edited: value === "query" ? false : s.edited,
    options: { ...s.options, transpose: value === "query" ? false : s.options.transpose,
      columnIndices: value === "selection" ? [...selectionIndices(frame)] : s.options.columnIndices } }));
  const columns = (indices: number[]) => opt("columnIndices", indices);
  const move = (index: number, direction: number) => set(s => { const order = [...s.columnOrder], at = order.indexOf(index), next = at + direction;
    if (next < 0 || next >= order.length) return s; [order[at], order[next]] = [order[next], order[at]];
    return { ...s, columnOrder: order, options: { ...s.options, columnIndices: order.filter(c => s.options.columnIndices.includes(c)) } }; });
  const applyPreset = (index: number) => {
    const preset = [...builtinTransferPresets, ...state.presets][index]; if (!preset) return;
    const chosen = preset.options.format ?? state.options.format;
    format(mode === "copy" && chosen === "xlsx" ? "tsv" : chosen);
    set(s => ({ ...s, options: { ...s.options, ...preset.options, format: mode === "copy" && chosen === "xlsx" ? "tsv" : chosen, transpose:s.scope==="query" || s.allSets ? false : preset.options.transpose ?? s.options.transpose }, preset: String(index), error: "" }));
  };
  const data = scopedTransferData(frame, state.scope, state.edited);
  const canRequery = transferCanRequery(frame.source);
  const sql = ["insert", "update", "where"].includes(state.options.format);
  let error = state.options.columnIndices.length ? validateTransfer(data, state.options) : "请选择至少一个输出字段";
  if (state.options.nc) error = canRequery && mode === "file" ? null : "NC 迁移需要可重新查询的连接，请使用文件导出";
  if (state.scope === "query" && (!canRequery || ["where", "update"].includes(state.options.format))) error = "此来源或格式只能导出已加载数据";
  if (mode === "copy" && state.scope === "query") error = "全部重查请使用文件导出";
  if (state.allSets) error = frame.source.sheets?.length && state.options.format === "xlsx" ? null : "请选择 Excel 格式导出多个结果集";
  const rows = state.allSets ? frame.source.sheets?.reduce((n, s) => n + s.data.rows.length, 0) ?? 0 : scopeIndices(frame, state.scope).length;
  const summary = state.allSets ? `全部已加载结果集 · ${rows} 行` : `${transferScopeLabel[state.scope]} · ${state.scope === "query" ? "总行数未知" : `${rows} 行`} × ${state.options.columnIndices.length} 列`;
  const pick = async () => {
    if (lock.current) return; lock.current = true; patch({ busy: "pick", error: "" });
    try { const destination = await dbTransferApi.pick(state.options.format, state.fileName); if (destination) set(s => ({ ...s, destination, fileName: destination.path.split(/[\\/]/).pop() || s.fileName })); }
    catch (e) { patch({ error: `选择位置失败：${String(e)}` }); }
    finally { lock.current = false; patch({ busy: "" }); }
  };
  const run = async () => {
    if (lock.current || error) return;
    if (state.options.nc) { patch({ ncOpen: true }); return; }
    rememberTransferFormat(mode,state.options);
    lock.current = true;
    try {
      if (mode === "copy") { patch({ busy: "copy", error: "", notice:"" }); if (!await copyTransfer(data, state.options, frame.source)) patch({ error: "复制未完成，设置已保留。可调整格式或改为文件导出。" }); else patch({notice:`已复制 ${rows} 行 × ${state.options.columnIndices.length} 列 · ${state.options.format.toUpperCase()}`}); }
      else await startTransferJob(frame.source, { id: frame.source.connId ?? "", sql: frame.source.sql,
        format: state.options.format, fileName: state.fileName, options: state.options,
        destinationToken: state.destination?.token, timeoutSec: frame.source.timeoutSec ?? 300, maxRows: 0,
        expectedColumns: state.allSets ? undefined : frame.data.columns.map(c => c.name), params: state.scope === "query" ? frame.source.params : undefined,
        context: { source: frame.source.source, scope: summary },
        data: state.scope === "query" || state.allSets ? undefined : data,
        sheets: state.allSets ? frame.source.sheets : undefined,
      }, summary, {frame,seed:{options:{...state.options},scope:state.scope,edited:state.edited,columnOrder:[...state.columnOrder],allSets:state.allSets,fileName:state.fileName,destination:state.destination ? {...state.destination} : null}});
    } finally { lock.current = false; patch({ busy: "" }); }
  };
  const savePreset = () => { try { patch({ presets: saveTransferPreset(state.presetName, state.options), savingPreset: false, presetName: "" }); toast("输出预设已保存", "success"); } catch (e) { patch({ error: String(e) }); } };
  return { state, patch, opt, format, scope, allSets, columns, move, applyPreset, savePreset, pick, run, data, error, canRequery, sql, summary, rows };
}
