import { useEffect, useRef } from "react";
import { useTxEpoch } from "../lib/dbTxEpoch";
import { reportEditCount, tableEditKey } from "../lib/dbDirtyEdits";

/**
 * 表页与标签生命周期相关的两个副作用（单拎出来是为了不把 TableData 堆过门禁）：
 *
 * - 把「还有几处没写回」登记给标签条 / 切文档 / 切子页 / 关闭流程；
 * - 同一会话刚提交或回滚过时，网格里的值可能已经不代表库里的状态：确认后重新读取。
 *   回滚尤其危险——`onCommitted` 写进内存的「已写回」值在库里已经被撤掉了。
 */
export function useTableTabSync(
  tabId: string,
  connId: string | null,
  dirtyCount: number,
  confirmReload: () => Promise<boolean>,
  reload: () => Promise<void>,
) {
  useEffect(() => {
    reportEditCount(tableEditKey(tabId), dirtyCount);
  }, [tabId, dirtyCount]);
  useEffect(() => () => reportEditCount(tableEditKey(tabId), 0), [tabId]);

  const txEpoch = useTxEpoch(connId, null);
  const seen = useRef(txEpoch.seq);
  useEffect(() => {
    if (txEpoch.seq === seen.current) return;
    seen.current = txEpoch.seq;
    void (async () => { if (await confirmReload()) await reload(); })();
  }, [txEpoch.seq, confirmReload, reload]);
}
