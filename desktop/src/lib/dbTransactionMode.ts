import { ask } from "./dbConfirm";
import { connOf, ensureSlot, getDb, patchTab, rtOf, sqlTabOf, txAction, type SqlTab } from "./dbStore";

/** 等待确认或申请槽后重新核对身份，不能把旧标签的操作写回新连接。 */
export async function setSqlTransactionMode(tabId: string, connId: string, on: boolean): Promise<void> {
  const start = sqlTabOf(tabId);
  const valid = (slot: string | null | undefined) => {
    const t = sqlTabOf(tabId);
    return t?.connId === connId && t.slot === slot && !t.running && getDb().active === tabId && rtOf(connId).status === "connected";
  };
  if (!start || !valid(start.slot)) return;
  const initialTx = start.slot ? start.tx : rtOf(connId).tx;
  if (on === (initialTx?.autoCommit ?? connOf(connId)?.autoCommit ?? false)) return;
  let confirmed = false;
  const confirm = () => ask(
    "切换到自动提交？",
    `「${start.title}」· ${connOf(connId)?.name ?? "数据库"}：切换到自动提交会立即提交所切换会话中此前未提交的写入，之后的写入也会自动提交。已提交的内容无法再通过回滚撤销。其他会话的事务仍需分别处理。`,
    "切换到自动提交",
    true,
  );
  if (on && (initialTx?.statements ?? 0) > 0) {
    if (!(await confirm()) || !valid(start.slot)) return;
    confirmed = true;
  }
  // 保留懒申请槽与失败退回 primary 的业务规则。
  const slot = await ensureSlot(tabId, connId);
  if (!valid(slot ?? start.slot)) return;
  const currentTx = slot ? sqlTabOf(tabId)?.tx : rtOf(connId).tx;
  if (on && !confirmed && (currentTx?.statements ?? 0) > 0) {
    if (!(await confirm()) || !valid(slot ?? start.slot)) return;
  }
  const next = await txAction(connId, on ? "autocommit-on" : "autocommit-off", slot);
  // 请求已发出后用户仍可离开；返回值只写回仍持有原槽的标签。
  const current = sqlTabOf(tabId);
  if (slot && current?.connId === connId && current.slot === slot) patchTab<SqlTab>(tabId, { tx: next });
}
