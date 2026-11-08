import type { SearchPackStatus } from "../../lib/searchPackStatus";

/**
 * 首次建内容包时的提示条。
 *
 * 建包要逐个读 8 千多个文件（冷缓存约两分钟），这段时间搜索仍走磁盘；
 * 不说一声的话用户只会觉得「又慢回去了」。包就绪或队列清空后自动消失。
 * 抽成独立组件是为了不把 SearchTab 撑过组件体量门禁（规则 7）。
 */
export function SearchPackNotice({ status }: { status: SearchPackStatus | null }) {
  if (!status) return null;
  const busy = !status.ready && (status.building || status.pending > 0);
  return (
    <>
      {busy && (
        <div
          className="border-b border-border bg-muted/40 px-3 py-1.5 text-[11.5px] leading-relaxed text-muted-foreground"
          data-testid="search-pack-notice"
        >
          正在建立搜索索引
          {status.pending > 0 ? `（含 ${status.pending} 个工程排队）` : ""}
          ：首次约需 1–2 分钟，本次搜索仍会逐个读文件；建好后自动变快，无需任何操作。
        </div>
      )}
      {status.lastError && (
        <div className="border-b border-border px-3 py-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
          搜索索引未就绪：{status.lastError}；搜索照常可用。
        </div>
      )}
    </>
  );
}
