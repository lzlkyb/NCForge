import { useState } from "react";
import "../../db-console.css";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { friendlyDbError } from "../../lib/db";
import { connOf } from "../../lib/dbStore";
import { dbApi, type ExportInsertResult } from "../../lib/dbApi";
import { downloadText } from "../../lib/resultExport";

/** 每 N 行提交一次的备选值。0 = 全程只在结尾提交。 */
const COMMITS = [0, 500, 1000, 5000];

/**
 * 导出 INSERT 脚本（NC 基础数据迁移）。
 *
 * 数据由后端单独开会话取全，前端只负责选项与落盘——结果网格里只有一页（默认 500 行），
 * 在界面上拼 insert 等于「导出你看见的那点数据」。
 */
export function InsertExportDialog({ connId, table, sql, schema, onClose }: {
  connId: string;
  /** 默认目标表名（可改）。 */
  table: string;
  /** 取数语句。 */
  sql: string;
  /** 默认 schema（可改，留空 = 不写前缀）。 */
  schema?: string | null;
  onClose: () => void;
}) {
  const conn = connOf(connId);
  const [opt, setOpt] = useState({
    table,
    schema: schema ?? "",
    maxRows: 5000,
    commitEvery: 0,
    multilang: true,
  });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ExportInsertResult | null>(null);

  const set = <K extends keyof typeof opt>(k: K, v: (typeof opt)[K]) => setOpt((o) => ({ ...o, [k]: v }));

  const run = async () => {
    if (!opt.table.trim()) return toast("目标表名不能为空", "warning");
    setBusy(true);
    try {
      const r = await dbApi.exportInsert({
        id: connId,
        sql,
        table: opt.table.trim(),
        schema: opt.schema.trim() || null,
        multilang: opt.multilang,
        commitEvery: opt.commitEvery,
        maxRows: opt.maxRows,
      });
      downloadText(r.fileName, r.sqlText, "text/plain", false);
      setDone(r);
      toast(`已生成 ${r.fileName}（${r.rows} 行）`, r.truncated ? "warning" : "success");
    } catch (e) {
      toast(`导出失败：${friendlyDbError(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} className="modal-surface dbx-dlg" ariaLabel="导出为 INSERT 脚本">
      <div className="hd">
        <Icon name="download" size={16} />
        导出为 INSERT 脚本
        <span className="dbx-muted" style={{ fontWeight: 400, fontSize: 12 }}>
          {conn?.name ?? "连接"} · {conn?.user ?? ""}
        </span>
      </div>
      <div className="bd">
        <label htmlFor="exp-table">目标表</label>
        <input
          id="exp-table"
          className="dbx-inp mono"
          value={opt.table}
          onChange={(e) => set("table", e.target.value)}
          placeholder="bd_material"
        />

        <label htmlFor="exp-schema">Schema</label>
        <input
          id="exp-schema"
          className="dbx-inp mono"
          value={opt.schema}
          onChange={(e) => set("schema", e.target.value)}
          placeholder="留空 = 不写前缀"
        />

        <label htmlFor="exp-rows">行数上限</label>
        <input
          id="exp-rows"
          className="dbx-inp mono"
          type="number"
          min={1}
          max={100000}
          value={opt.maxRows}
          onChange={(e) => set("maxRows", Math.max(1, Math.min(100000, Number(e.target.value) || 1)))}
        />

        <label htmlFor="exp-commit">提交间隔</label>
        <select
          id="exp-commit"
          className="dbx-inp"
          value={opt.commitEvery}
          onChange={(e) => set("commitEvery", Number(e.target.value))}
        >
          {COMMITS.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? "只在结尾提交" : `每 ${n} 行 commit`}
            </option>
          ))}
        </select>

        <label htmlFor="exp-ml">多语列</label>
        <label htmlFor="exp-ml" style={{ display: "flex", alignItems: "center", gap: 6, color: "inherit" }}>
          <input
            id="exp-ml"
            type="checkbox"
            checked={opt.multilang}
            onChange={(e) => set("multilang", e.target.checked)}
          />
          <span>
            按 NC 约定写 <code>'~'</code>（基础列保留，<code>X2</code>..<code>X6</code> 整族不导）
          </span>
        </label>

        <div className="dbx-hint">
          取数语句：<code className="dbx-mono">{sql.length > 90 ? `${sql.slice(0, 90)}…` : sql}</code>
          {opt.multilang && "　多语判据是「基础列 + X2..X6 至少 3 列」，导出后请核对下面的识别结果。"}
        </div>

        {done && <Result r={done} />}
      </div>
      <div className="ft">
        <span className="dbx-muted">主键前置 · blob 写 null · 日期显式 to_date</span>
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn" onClick={onClose}>
          关闭
        </button>
        <button type="button" className="dbx-btn pri" disabled={busy} onClick={() => void run()}>
          {busy ? <Icon name="spinner" size={12} /> : <Icon name="download" size={12} />}
          {done ? "重新导出" : "导出"}
        </button>
      </div>
    </Modal>
  );
}

/** 导出结果：行数 / 规则命中 / 告警。告警别吞掉——截断与多语丢列都会让人以为数据"少了"。 */
function Result({ r }: { r: ExportInsertResult }) {
  return (
    <div className="dbx-hint" style={{ gridColumn: "1 / -1", marginTop: 6 }}>
      <div style={{ color: "hsl(var(--foreground))", marginBottom: 4 }}>
        已下载 <b className="dbx-mono">{r.fileName}</b>：{r.rows} 行 · {(r.ms / 1000).toFixed(1)}s
        {r.truncated && <b style={{ color: "hsl(var(--destructive-ink))" }}>（非全量）</b>}
      </div>
      {r.multilang.length > 0 && <div>多语列：{r.multilang.join("，")}</div>}
      {r.dropped.length > 0 && (
        <div>
          跳过的语种列（{r.dropped.length}）：<span className="dbx-mono">{r.dropped.join(", ")}</span>
        </div>
      )}
      {r.blobNulls > 0 && <div>写了 {r.blobNulls} 个 null（二进制列不导内容）</div>}
      {r.warnings.map((w) => (
        <div key={w} style={{ color: "hsl(var(--destructive-ink))" }}>
          · {w}
        </div>
      ))}
    </div>
  );
}
