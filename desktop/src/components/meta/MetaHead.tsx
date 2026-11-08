import type { BmfEntry } from "../../lib/bmf";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";

/** 组件头：名称 / 路径 / 严重度汇总 / 校验与新建。与视图切换解耦，独立成块。 */
export function MetaHead({
  entry,
  counts,
  busy,
  onRevalidate,
  onNew,
  editing = false,
  onIssues,
}: {
  entry: BmfEntry;
  counts: { error: number; warn: number; info: number };
  busy: boolean;
  onRevalidate: () => void;
  onNew: () => void;
  editing?: boolean;
  onIssues?: () => void;
}) {
  return (
    <header className="meta-main-head">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-[15px] font-semibold">{entry.displayName || entry.name}</h2>
          <span className="meta-mono text-[11px] text-muted-foreground">{entry.name}</span>
          {entry.error && <span className="meta-tag meta-tag-danger">解析失败</span>}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="meta-sev-summary" disabled={editing} onClick={onIssues} aria-label="查看校验问题">
          {counts.error > 0 && <span className="sev-error">{counts.error} 错误</span>}
          {counts.warn > 0 && <span className="sev-warn">{counts.warn} 警告</span>}
          {counts.info > 0 && <span className="sev-info">{counts.info} 提示</span>}
          {!counts.error && !counts.warn && !counts.info && <span>无校验问题</span>}
        </button>
        <Button size="sm" variant="outline" onClick={onRevalidate} disabled={busy || editing}>
          <Icon name="shield" size={13} /> 校验
        </Button>
        <Menu portal trigger={(open,toggle)=><button type="button" className="meta-link" aria-label="组件文件信息与操作" aria-haspopup="menu" aria-expanded={open} onClick={toggle}><Icon name="more" size={14}/></button>}>
          {close=><><MenuItem label="新建组件" icon="filePlus" disabled={editing} onClick={()=>{close();onNew();}}/><p className="meta-file-info">{entry.path}</p></>}
        </Menu>
      </div>
    </header>
  );
}
