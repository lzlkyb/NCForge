/**
 * 这条语句本身是否结束了事务（手写 COMMIT / ROLLBACK、DDL 的隐式提交）。
 *
 * 为什么前端也要判一次：后端计数器会归零（`NcDbBridge.trackTx`），但界面上的
 * 「某条语句是在提交前还是提交后执行的」要靠 `dbTxEpoch` 才知道。不认手写的
 * COMMIT，结果页会一直写着「尚未提交」——DataGrip 2025.3 专门补的也是这块
 * （在控制台里跑 COMMIT/ROLLBACK 后按钮跟着变灰、Oracle 的 DDL 隐式提交也跟踪）。
 *
 * `implicit` 与 `commit` 分开：DDL 由数据库自己提交，这条语句的结果应当直接标
 * 「已自动提交」；但它是**用户刚做的事**还是**数据库顺手做的**，决定的副作用不同
 * （手写 COMMIT 要让表页重新读，DDL 不必弹「丢弃未保存改动」）。
 *
 * 只判「一句话」：调用方传进来的是单条语句（执行器已经切好），不做多语句扫描。
 */
export type TxControl = "commit" | "rollback" | "implicit";

/** 剥掉开头的空白与注释：`-- 收尾\ncommit;` 也要认出来。 */
function headOf(sql: string): string[] {
  let s = sql;
  for (;;) {
    s = s.replace(/^\s+/, "");
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      if (nl < 0) return [];
      s = s.slice(nl + 1);
      continue;
    }
    if (s.startsWith("/*")) {
      const end = s.indexOf("*/", 2);
      if (end < 0) return [];
      s = s.slice(end + 2);
      continue;
    }
    break;
  }
  return s
    .replace(/;\s*$/, "")
    .split(/[\s(]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => w.toLowerCase());
}

/** Oracle 里会自动提交的 DDL / DCL：执行完事务就结束了，跟手写 COMMIT 一个效果。 */
const IMPLICIT_COMMIT = new Set([
  "create", "alter", "drop", "truncate", "rename", "comment",
  "grant", "revoke", "analyze", "audit", "noaudit",
]);

export function txControlOf(sql: string): TxControl | null {
  const [head, second] = headOf(sql);
  if (!head) return null;
  if (head === "commit") return "commit";
  // `rollback to savepoint x` 只回到保存点，事务还在，不能当成结束。
  if (head === "rollback") return second === "to" ? null : "rollback";
  return IMPLICIT_COMMIT.has(head) ? "implicit" : null;
}
