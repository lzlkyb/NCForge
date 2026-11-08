import { useState } from "react";
import { filterColumns, STATUS_TEXT, summarize, type StructDiff } from "../../lib/dbStructDiff";
import { Icon } from "../ui/icon";
import { StructDiffScript } from "./StructDiffScript";

/**
 * 结构对比结果：汇总 → 主键 → 列 → 索引 → 脚本。
 *
 * 顺序按「改错代价」排：先看主键（改它等于重建索引，最贵），再看列，最后索引。
 * 一致的列默认折叠——两张同源的表几十列里只有两三列不同，全列出来等于让人自己找。
 */
export function StructDiffResult({ diff }: { diff: StructDiff }) {
  const [showSame, setShowSame] = useState(false);
  const sum = summarize(diff);
  const cols = filterColumns(diff.columns, showSame ? "all" : "diff");
  const changedIndexes = diff.indexes.filter((i) => i.status !== "same" || i.renamed);

  return (
    <div className="dbx-diff">
      <div className="dbx-diff-sum">
        <span className="dbx-diff-chip" data-tone="warn">左侧独有 {sum.onlyLeft}</span>
        <span className="dbx-diff-chip" data-tone="danger">右侧独有 {sum.onlyRight}</span>
        <span className="dbx-diff-chip" data-tone="info">属性不同 {sum.changed}</span>
        <span className="dbx-diff-chip">{diff.columns.length} 列一致</span>
        <span className="dbx-sp" />
        <label className="dbx-diff-toggle">
          <input type="checkbox" checked={showSame} onChange={(e) => setShowSame(e.target.checked)} />
          一并显示一致的列
        </label>
      </div>

      {diff.pkChanged && (
        <div className="dbx-diff-note" data-tone="warn">
          <Icon name="key" size={12} /> 主键不同：左 {diff.left.pk.length ? diff.left.pk.join(", ") : "（无）"} / 右{" "}
          {diff.right.pk.length ? diff.right.pk.join(", ") : "（无）"}
        </div>
      )}
      {diff.commentChanged && (
        <div className="dbx-diff-note" data-tone="info">
          表注释不同：左 {diff.left.comment ?? "（无）"} / 右 {diff.right.comment ?? "（无）"}
        </div>
      )}

      {cols.length === 0 ? (
        <div className="dbx-empty" style={{ padding: 16 }}>列结构完全一致</div>
      ) : (
        <div className="dbx-meta">
          <table>
            <thead>
              <tr>
                <th style={{ width: 220 }}>列</th>
                <th style={{ width: 130 }}>差异</th>
                <th style={{ width: 220 }}>左（{diff.left.label}）</th>
                <th style={{ width: 220 }}>右（{diff.right.label}）</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {cols.map((c) => (
                <tr key={`${c.status}:${c.name}`} data-status={c.status}>
                  <td className="mono">{c.name}</td>
                  <td><span className="dbx-diff-badge" data-status={c.status}>{STATUS_TEXT[c.status]}</span></td>
                  <td className="mono">{c.left ? `${c.left.ty}${c.left.nullable ? "" : " not null"}` : "—"}</td>
                  <td className="mono">{c.right ? `${c.right.ty}${c.right.nullable ? "" : " not null"}` : "—"}</td>
                  <td>
                    {c.changes.length === 0 ? (
                      <span className="dbx-muted">{c.status === "same" ? "无差异" : c.status === "onlyLeft" ? "需要新增" : "需要删除"}</span>
                    ) : (
                      c.changes.map((f) => (
                        <div key={f.field}>
                          <span className="dbx-muted">{f.field}：</span>
                          {f.left ?? "（空）"} → {f.right ?? "（空）"}
                        </div>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {changedIndexes.length > 0 && (
        <div className="dbx-diff-idx">
          {changedIndexes.map((ix) => (
            <div key={`${ix.status}:${ix.name}`} className="dbx-diff-note" data-tone={ix.status === "same" ? "info" : "warn"}>
              <Icon name="layers" size={12} />
              {ix.status === "same"
                ? `索引同名同列但名字不同：左 ${ix.leftName} / 右 ${ix.rightName}（不改）`
                : ix.status === "onlyLeft"
                  ? `右侧缺索引 ${ix.leftName}（${ix.unique ? "唯一" : "普通"}，列 ${ix.columns.join(", ")}）`
                  : `右侧多索引 ${ix.rightName}（${ix.unique ? "唯一" : "普通"}，列 ${ix.columns.join(", ")}）`}
            </div>
          ))}
        </div>
      )}

      <StructDiffScript diff={diff} />
    </div>
  );
}
