import type { BmfImportPreview } from "../../lib/bmf";
import { Button } from "../ui/button";

const STATUS_LABEL: Record<BmfImportPreview["rows"][number]["status"], string> = {
  add: "新增",
  update: "修改",
  same: "无变化",
  error: "错误",
};

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** 导入预览的表格区块：汇总、逐行差异、写入按钮。 */
export function MetaExcelPreview({
  preview,
  busy,
  onWrite,
}: {
  preview: BmfImportPreview;
  busy: boolean;
  onWrite: () => void;
}) {
  const blocked = preview.errors > 0 || preview.ops.length === 0;
  return (
    <>
      <div className="meta-excel-sum">
        <span className="is-added">+{preview.add}</span>
        <span className="is-changed">~{preview.update}</span>
        <span className="is-same">={preview.same}</span>
        <span className={preview.errors ? "is-error" : "is-same"}>!{preview.errors}</span>
        <span className="meta-note m-0">
          {baseName(preview.file)} · 工作表「{preview.sheet}」· 待写 {preview.ops.length} 条操作
        </span>
      </div>
      <div className="meta-excel-rows">
        <table className="meta-excel-table">
          <thead>
            <tr>
              <th>行</th>
              <th>实体</th>
              <th>字段</th>
              <th>状态</th>
              <th>差异</th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((r) => (
              <tr key={r.row} className={`is-${r.status}`}>
                <td className="meta-excel-rowno">{r.row}</td>
                <td>{r.entity || "—"}</td>
                <td>{r.attrName || "—"}</td>
                <td className="meta-excel-status">{STATUS_LABEL[r.status]}</td>
                <td className="meta-excel-changes">
                  {r.message || (
                    r.changes.length === 0 ? (
                      <span className="meta-note m-0">与当前一致</span>
                    ) : (
                      r.changes.map((c, i) => (
                        <span key={`${c.field}-${i}`} className="meta-excel-change">
                          <b>{c.field}</b>
                          {c.before || c.after ? (
                            <>
                              <code>{c.before || "—"}</code>
                              <span className="meta-compare-arrow">→</span>
                              <code>{c.after || "—"}</code>
                            </>
                          ) : null}
                        </span>
                      ))
                    )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="meta-excel-actions">
        {preview.errors > 0 && (
          <span className="meta-error m-0">有 {preview.errors} 行错误，修正模板后再写入。</span>
        )}
        {preview.errors === 0 && preview.ops.length === 0 && (
          <span className="meta-note m-0">没有需要写入的变更。</span>
        )}
        <Button size="sm" variant="outline" onClick={onWrite} disabled={blocked || busy}>
          {busy ? "写入中…" : `写入 ${preview.ops.length} 条变更`}
        </Button>
      </div>
    </>
  );
}
