import type { BmfEntry } from "../../lib/bmf";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

/** 组件头：名称 / 路径 / 严重度汇总 / 校验与新建。与视图切换解耦，独立成块。 */
export function MetaHead({
  entry,
  counts,
  busy,
  onRevalidate,
  onNew,
}: {
  entry: BmfEntry;
  counts: { error: number; warn: number; info: number };
  busy: boolean;
  onRevalidate: () => void;
  onNew: () => void;
}) {
  return (
    <header className="meta-main-head">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-[15px] font-semibold">{entry.displayName || entry.name}</h2>
          <span className="meta-mono text-[11px] text-muted-foreground">{entry.name}</span>
          {entry.error && <span className="meta-tag meta-tag-danger">解析失败</span>}
        </div>
        <div className="meta-path" title={entry.path}>
          {entry.path}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="meta-sev-summary">
          <span className="sev-error">{counts.error} 错误</span>
          <span className="sev-warn">{counts.warn} 警告</span>
          <span className="sev-info">{counts.info} 提示</span>
        </div>
        <Button size="sm" variant="outline" onClick={onRevalidate} disabled={busy}>
          <Icon name="shield" size={13} /> 校验
        </Button>
        <Button size="sm" variant="ghost" onClick={onNew}>
          <Icon name="filePlus" size={13} /> 新建
        </Button>
      </div>
    </header>
  );
}
