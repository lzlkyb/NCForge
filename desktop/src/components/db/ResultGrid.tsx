import { useMemo } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { cellText, isNumericType, toTsv, type QueryResult } from "../../lib/db";

/**
 * 查询结果表。
 *
 * 三个细节都是有理由的：
 * - 类型挂在表头第二行（`VARCHAR2(40)`）——排障时值本身看不出类型，而「这一列是不是 NULL」
 *   往往就是答案；
 * - NULL 斜体灰字、与空串分开：空串和 NULL 在 NC 的数据里是完全不同的两种状态；
 * - 行号自己加一列：用户会拿行号跟 DBA 对话（「第 37 行那条」），不能靠滚动数。
 */
export function ResultGrid({ data }: { data: QueryResult }) {
  const numeric = useMemo(() => data.columns.map((c) => isNumericType(c.type)), [data.columns]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toTsv(data.columns, data.rows));
      toast("已复制为 TSV", "success");
    } catch (e) {
      toast(`复制失败：${e}`, "error");
    }
  };

  return (
    <div className="dq-result">
      <div className="dq-res-head">
        <span>结果</span>
        <b>
          {data.rowCount === 0 ? "0 行" : `1–${data.rowCount} 行`}
          {data.truncated ? "（已截断）" : ""}
        </b>
        <span>· {data.ms} ms</span>
        <span className="dq-sp" />
        <span className="dq-muted">单条 SELECT · Ctrl+Enter 执行</span>
        <button type="button" className="dq-btn dq-btn-sm" onClick={() => void copy()}>
          <Icon name="copy" size={12} />
          复制为 TSV
        </button>
      </div>

      {data.rowCount === 0 ? (
        <div className="dq-empty-rows">这条语句没有返回数据</div>
      ) : (
        <div className="dq-grid-wrap">
          <table className="dq-grid">
            <thead>
              <tr>
                <th className="rn">#</th>
                {data.columns.map((c, i) => (
                  <th key={`${c.name}-${i}`}>
                    {c.name}
                    <span className="t">{c.type}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, ri) => (
                <tr key={ri}>
                  <td className="rn">{ri + 1}</td>
                  {row.map((v, ci) => (
                    <td
                      key={ci}
                      data-n={numeric[ci] ? "" : undefined}
                      data-null={v === null || v === undefined ? "" : undefined}
                      title={v === null || v === undefined ? "NULL" : String(v)}
                    >
                      {cellText(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="dq-foot">
        <span>
          只读事务 <b>SET TRANSACTION READ ONLY</b>
        </span>
        <span>·</span>
        <span>
          执行后 <b>rollback</b>（语句里藏了 DML 也落不了盘）
        </span>
        <span className="dq-sp" />
        {data.truncated && <span className="dq-warn">结果超过行上限，只显示了前 {data.rowCount} 行</span>}
      </div>
    </div>
  );
}
