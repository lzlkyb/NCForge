import { formatRelativeTime } from "./utils";

/**
 * 本地历史版本的时间展示：相对时间做正文（「12 分钟前」），绝对时间做 title
 * （鼠标悬停看精确时刻，年以上的版本相对时间会丢信息）。
 *
 * 相对时间的阶梯（刚刚 / N 分钟前 / N 小时前 / N 天前 / N 个月前 / N 年前）
 * 复用 `utils.formatRelativeTime`，不另抄一份——两处口径必须一致，否则同一个
 * 时间里「备份列表」和「历史面板」会说两种话。
 */

/** Unix ms → `YYYY-MM-DD HH:MM:SS`（本地时区）。 */
export function formatAbsoluteTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * @param ts  归档时间（Unix ms）
 * @param now 当前时间（Unix ms，测试注入用；不传取 `Date.now()`）
 */
export function formatHistoryTime(ts: number, now: number = Date.now()): { label: string; title: string } {
  const title = formatAbsoluteTime(ts);
  return { label: formatRelativeTime(title, now), title };
}
