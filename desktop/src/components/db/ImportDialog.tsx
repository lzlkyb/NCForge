import { useState } from "react";
import "../../db-console.css";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { dbSourceOf, type ColumnInfo } from "../../lib/dbApi";
import { connOf } from "../../lib/dbStore";
import { saveFailedRows } from "../../lib/importReport";
import { useImportSource } from "../../hooks/useImportSource";
import { useImportRun, BATCH } from "../../hooks/useImportRun";
import { MapGrid } from "./ImportColumnMap";
import { ImportProgress } from "./ImportProgress";

/** 预览最多看几行；导入前扫一眼列对不对就够，不再多。 */
const PREVIEW = 5;

/**
 * CSV / TSV / JSON / XLSX 导入到表。
 *
 * 三段式：选文件 → 对列（自动按列名匹配，可改，可忽略）→ 执行（分批、逐批报结果）。
 * **列映射是这里唯一的判断点**：对错了不会报错，只会把名字写进日期列。所以自动只匹配
 * 「看起来就是同一列」的，其余留给用户手点。
 *
 * 2026-11-17 拆解：读文件与列映射进 `useImportSource`，分批执行与取消进 `useImportRun`。
 * 这个文件曾用满 8 个 useState+useEffect 的体量门禁额度，再往组件里塞逻辑就过不了门禁。
 */
export function ImportDialog({ connId, table, cols, onClose, onDone, tabId }: {
  connId: string;
  table: string; tabId?: string;
  /** 目标表的列；`null` 时自己读一次（表页是懒加载的，进页面时可能还没读完）。 */
  cols: ColumnInfo[] | null;
  onClose: () => void;
  /** 导入结束后刷新数据页。 */
  onDone: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const source = useImportSource({ connId, table, tabId, cols, setErr });
  const { target, src, map, setMap, skip, setSkip, parsed, picked, dupTarget, readFile, fmt, setFmt, dateInfo } = source;
  /** 生效的日期格式：用户选的优先，其次唯一推断（见 `useImportSource::dateInfo`）。 */
  const fmtOf = (to: number) => dateInfo[to]?.id;
  const runner = useImportRun({
    connId,
    table,
    tabId,
    parsed,
    target,
    picked,
    skip,
    fmtOf,
    setErr,
    onDone,
  });
  const { busy, out, run, cancel } = runner;
  /** 歧义未确认的日期列数：不选一个就不许导，否则静默错日期。 */
  const pendingDate = Object.values(dateInfo).filter((i) => i.needsChoice).length;

  // 导入结束（out 有值）后不允许再点：同一份文件再导一遍就是整批重复数据，
  // 而表上往往没有唯一约束兜底。要再导必须先重新选文件（readFile 会清掉 out）。
  const canRun = !!parsed && !!target && picked.length > 0 && !dupTarget && !busy && !out && pendingDate === 0;
  // 导入中途关窗会让分批循环失去界面：已写入的批次无法撤回，失败也没人看见。
  // 关不掉比「悄悄写了一半」诚实——按钮、Esc、遮罩三条路统一由 busy 拦下。
  const requestClose = () => {
    if (!busy) onClose();
  };

  return (
    <Modal keepMountedWhenInactive open onClose={requestClose} closeOnOverlay={!busy} className="modal-surface dbx-dlg wide" ariaLabel={`导入数据到 ${table}`}>
      <div className="hd">
        <Icon name="upload" size={16} />
        导入数据
        <span className="dbx-muted" style={{ fontWeight: 400, fontSize: 12 }}>
          → {table.toLowerCase()}
        </span>
        {/* 导入写的是哪个库必须一直看得见：只看表名，跨账套时很容易导错地方 */}
        <span className="dbx-muted" style={{ fontWeight: 400, fontSize: 12, marginLeft: "auto" }}>{dbSourceOf(connOf(connId))}</span>
      </div>
      <div className="bd one">
        <p className="dbx-hint">写入方式：新增记录 · 每批最多 {BATCH} 行，使用独立会话提交。停止后，已提交的批次仍会保留。</p>
        <div className="dbx-hint">
          读本机的 CSV / TSV / JSON / XLSX 文件：CSV 的 UTF-8 与 Excel 默认的 GBK/GB18030 自动识别（文件名旁会标出实际编码）；JSON 支持对象数组、二维数组与单对象；
          XLSX 只读<b>第一张工作表</b>（合并单元格只取值、公式只取缓存结果，超过 20 万行报错而不是截断）。空单元格写成 <b>NULL</b>（Oracle 里空串本来就是 NULL）；
          XLSX 里的日期单元格按 Excel 的日期格式转成 <span className="dbx-mono">YYYY-MM-DD HH24:MI:SS</span>。
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
          {/* label 包 input：点它等于点 input，省掉 useRef（组件体量门禁按 hook 数算账） */}
          <label
            className="dbx-btn"
            style={busy ? { opacity: 0.5, pointerEvents: "none" } : undefined}
            aria-disabled={!!busy}
          >
            <Icon name="upload" size={12} />
            选择文件
            <input
              type="file"
              accept=".csv,.tsv,.txt,.json,.xlsx,.xlsm"
              disabled={!!busy}
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void readFile(f);
                e.target.value = "";
              }}
            />
          </label>
          {src.reading && <span role="status"><Icon name="spinner" size={12} />读取文件中…</span>}
          {src.name && (
            <span className="dbx-mono dbx-muted">
              {src.name}
              {src.encoding && ` · ${src.encoding}`}
              {src.sheet && ` · 工作表 ${src.sheet}`}
            </span>
          )}
          {parsed && (
            <span className="dbx-muted">
              {parsed.headers.length} 列 · {parsed.rows.length} 行
              {parsed.blankLines > 0 && `（跳过 ${parsed.blankLines} 个空行）`}
            </span>
          )}
        </div>

        {parsed && (
          <MapGrid
            headers={parsed.headers}
            samples={parsed.rows.slice(0, PREVIEW)}
            map={map}
            cols={target ?? []}
            onChange={(v, i) => setMap(map.map((m, k) => (k === i ? v : m)))}
            dupTarget={dupTarget}
            dateInfo={dateInfo}
            fmt={fmt}
            onFmt={(to, id) => setFmt({ ...fmt, [to]: id })}
          />
        )}
        {parsed && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10 }}>
            <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
            遇错跳过坏行（否则这一批整批退回）
          </label>
        )}

        <ImportProgress
          busy={busy}
          err={err}
          out={out}
          onExportFailed={
            parsed && out && out.failed.length > 0
              ? () => saveFailedRows(table, parsed.headers, parsed.rows, out.failed)
              : undefined
          }
        />
      </div>
      <div className="ft">
        <span className="dbx-muted">
          {parsed ? `将写入 ${picked.length} 列` : "先选一个文件"}
          {!target && " · 读取表结构…"}
          {pendingDate > 0 && ` · ${pendingDate} 个日期列格式待确认`}
        </span>
        <span className="dbx-sp" />
        {busy ? (
          // 写入中不能关窗（已写的批次撤不回），但必须留一条停下来的路：
          // 只置标志、当前批写完再停，进度与结果仍然可见。
          // 点完要立刻有反馈：大表上一批可能跑几十秒，按钮不变用户会以为没点上。
          <button type="button" className="dbx-btn ghost" disabled={busy.canceling} onClick={cancel}>
            {busy.canceling ? "取消中…" : "取消导入"}
          </button>
        ) : (
          <button type="button" className="dbx-btn ghost" onClick={requestClose}>
            {out ? "关闭" : "取消"}
          </button>
        )}
        <button type="button" className="dbx-btn" disabled={!canRun} title={out ? "这次导入已结束；要再导一遍请重新选择文件" : undefined} onClick={() => void run()}>
          <Icon name={busy ? "spinner" : "upload"} size={12} />
          {busy ? "导入中…" : "开始导入"}
        </button>
      </div>
    </Modal>
  );
}
