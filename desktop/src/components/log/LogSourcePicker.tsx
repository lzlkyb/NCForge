import { useMemo, useState } from "react";
import { Menu, MenuItem } from "../ui/Menu";
import { Icon } from "../ui/icon";
import { formatSize, type LoggerGroup } from "../../lib/ncLog";

/** 常用来源占四个位置，已选项始终留在工具条，未读到配置的已选项也可取消。 */
export function LogSourcePicker({ groups, loggers, onToggle, onClear }: {
  groups: LoggerGroup[];
  loggers: string[];
  onToggle: (name: string) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const common = useMemo(() => {
    const priorities = [["nc", "nclog"], ["warningsql"], ["metadata"], ["pfxx"]];
    const chosen = priorities.flatMap((names) => {
      const group = groups.find((source) => names.includes(source.name.toLowerCase()));
      return group ? [group] : [];
    });
    const recent = [...groups].sort((a, b) => b.newestMs - a.newestMs);
    return [...chosen, ...recent.filter((group) => !chosen.includes(group))].slice(0, 4);
  }, [groups]);
  const chipNames = [...new Set([...common.map((group) => group.name), ...loggers])];
  const matching = groups.filter((group) => group.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="lg-chips" role="group" aria-label="日志来源">
      <button type="button" className="lg-chip" data-on={loggers.length === 0 || undefined}
        aria-pressed={loggers.length === 0} onClick={onClear}>
        全部<span className="lg-chip-n">{groups.length}</span>
      </button>
      {chipNames.map((name) => {
        const group = groups.find((source) => source.name === name);
        return <button key={name} type="button" className="lg-chip"
          data-on={loggers.includes(name) || undefined} aria-pressed={loggers.includes(name)}
          data-idle={group?.newestMs === 0 && !loggers.includes(name) || undefined}
          title={group ? `${group.files.length} 个文件 · ${formatSize(group.totalSize)}${group.level ? ` · 门限 ${group.level}` : ""}` : "当前配置中未找到此来源；点击取消选择"}
          onClick={() => onToggle(name)}>
          {name}<span className="lg-chip-n">{group?.files.length ?? "—"}</span>
        </button>;
      })}
      <Menu portal align="left" width="w-72 max-w-[calc(100vw-8px)]"
        trigger={(open, toggle) => <button type="button" className="lg-chip" aria-haspopup="menu"
          aria-expanded={open} onClick={toggle}>
          更多来源<Icon name="chevronDown" size={12} />
        </button>}>
        {(close) => <>
          <div className="p-1">
            <input className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-[13px] text-foreground"
              aria-label="搜索日志来源" placeholder="搜索来源名称" value={query} autoFocus
              onChange={(event) => setQuery(event.target.value)} />
          </div>
          <p className="px-2.5 py-1 text-xs text-muted-foreground">可多选；已选 {loggers.length} 个</p>
          {matching.length ? matching.map((group) => <MenuItem key={group.name} active={loggers.includes(group.name)} checked={loggers.includes(group.name)}
            label={<span className="min-w-0 truncate">{group.name}{loggers.includes(group.name) && <span className="sr-only">，已选择</span>}</span>}
            trailing={loggers.includes(group.name) ? <Icon name="check" size={13} /> : <span className="text-xs text-muted-foreground">{group.files.length} 文件</span>}
            onClick={() => onToggle(group.name)} />)
            : <p className="px-2.5 py-2 text-xs text-muted-foreground" role="status">没有匹配的日志来源</p>}
          <MenuItem label="完成" onClick={close} />
        </>}
      </Menu>
    </div>
  );
}
