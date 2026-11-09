/**
 * 「滚到底就续取」的判据。从 `ResultGrid` 的 scroll 处理里抽出来，只为让它可测：
 * 阈值、防重发（`loadedAt`）、加载中去重三条规则散在事件回调里，改一次要翻整块。
 *
 * `changed` = 行数相比上次触发时变过了（新行到了才允许再触发），
 * `loading` = 上一次续取还没回来。两个都不满足还往底部蹭，就只会连环发请求。
 */
export function shouldLoadMore(el: { scrollTop: number; clientHeight: number; scrollHeight: number }, options: {
  /** 有没有更多行可续（结果页传 `entry.hasMore` 等）。 */
  hasMore: boolean;
  loading: boolean;
  /** 行数是否与上次触发时不同。 */
  rowsChanged: boolean;
  /** 距底部多少 px 就算「滚到底」。 */
  margin: number;
}): boolean {
  const { hasMore, loading, rowsChanged, margin } = options;
  if (!hasMore || loading || !rowsChanged) return false;
  return el.scrollTop + el.clientHeight >= el.scrollHeight - margin;
}
