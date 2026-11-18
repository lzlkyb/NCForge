// 调试面板右栏：断点清单 + 异常断点开关 + 分组/静音。
//
// 断点存在 `lib/breakpoints`（按工作区隔离），这里只改清单与触发语义；
// 下发由 `debugSync` 订阅清单变化完成，视图不直接碰适配器。
// 编辑表单在 `DebugBreakpointEditor`，组 chip 行在 `DebugBreakpointGroups`：
// 这一列放的东西多，再塞两个五十行的块就过 300 行门禁了。
import { useMemo, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { baseName } from "../../lib/workspace";
import { useWorkspaceRoot } from "../../lib/workspaceSession";
import {
  breakpointGroups,
  breakpointInactiveReason,
  bpKey,
  clearAllBreakpoints,
  clearBreakpointGroup,
  removeBreakpointAt,
  renameBreakpointGroup,
  setBreakpointGroupEnabled,
  setMuted,
  updateBreakpointAt,
  useBreakpoints,
  type Breakpoint,
} from "../../lib/breakpoints";
import type { ExceptionFilter } from "../../lib/debug";
import { setExceptionFilter } from "../../lib/debugSession";
import { DebugBreakpointEditor, type BreakpointDraft } from "./DebugBreakpointEditor";
import { DebugBreakpointGroups } from "./DebugBreakpointGroups";

/** 行尾的小徽标：条件 / 命中次数 / 日志断点，一眼能看出这不是普通红点。 */
function Badges({ bp }: { bp: Breakpoint }) {
  return (
    <>
      {bp.condition && (
        <span className="dbg-bp-badge" title={`条件：${bp.condition}`}>
          条件
        </span>
      )}
      {bp.hitCondition && (
        <span className="dbg-bp-badge" title={`命中次数：${bp.hitCondition}`}>
          #{bp.hitCondition}
        </span>
      )}
      {bp.logMessage && (
        <span className="dbg-bp-badge" data-kind="log" title={`日志：${bp.logMessage}`}>
          日志
        </span>
      )}
      {bp.group && (
        <span className="dbg-bp-badge" data-kind="group" title={`所属组：${bp.group}`}>
          {bp.group}
        </span>
      )}
    </>
  );
}

export function DebugBreakpoints({
  availableFilters,
  enabledFilters,
  onOpenAt,
}: {
  availableFilters: ExceptionFilter[];
  enabledFilters: string[];
  onOpenAt: (path: string, line: number) => void;
}) {
  const { items: breakpoints, muted } = useBreakpoints(useWorkspaceRoot() ?? "");
  const [draft, setDraft] = useState<BreakpointDraft | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // 静音与组偏好和清单在同一个 view 快照里：任一变化都是新引用，直接算即可
  const groups = breakpointGroups();

  const fileGroups = useMemo(() => {
    const map = new Map<string, Breakpoint[]>();
    for (const b of breakpoints) {
      const list = map.get(b.path) ?? [];
      list.push(b);
      map.set(b.path, list);
    }
    return [...map.entries()]
      .map(([path, list]) => [path, [...list].sort((a, b) => a.line - b.line)] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
  }, [breakpoints]);

  const openEditor = (bp: Breakpoint) =>
    setDraft({
      key: bpKey(bp.path, bp.line),
      condition: bp.condition ?? "",
      hitCondition: bp.hitCondition ?? "",
      logMessage: bp.logMessage ?? "",
      group: bp.group ?? "",
    });

  const save = (bp: Breakpoint) => {
    if (!draft) return;
    updateBreakpointAt(bp.path, bp.line, {
      condition: draft.condition,
      hitCondition: draft.hitCondition,
      logMessage: draft.logMessage,
      group: draft.group,
    });
    setDraft(null);
  };

  return (
    <div className="dbg-bp-col">
      <div className="dbg-col-h">
        断点
        {breakpoints.length > 0 && <span>· {breakpoints.length}</span>}
        <span className="dbg-sp" />
        <button
          type="button"
          className="dbg-icon-btn dbg-hd-btn"
          data-on={muted || undefined}
          title={muted ? "取消静音：恢复全部断点" : "静音断点（Mute）：临时全部失效，清单保留"}
          onClick={() => setMuted(!muted)}
        >
          <Icon name="eyeOff" size={12} />
        </button>
        <button
          type="button"
          className="dbg-icon-btn dbg-hd-btn"
          data-on={enabledFilters.length > 0 || undefined}
          title="异常断点：在抛异常的位置停下"
          onClick={() => setFiltersOpen((v) => !v)}
        >
          <Icon name="alertTriangle" size={12} />
        </button>
        <button
          type="button"
          className="dbg-icon-btn dbg-hd-btn"
          disabled={breakpoints.length === 0}
          title="清空当前工作区的全部断点（之后可在行号槽重新点）"
          onClick={() => {
            const n = breakpoints.length;
            clearAllBreakpoints();
            toast(`已清除 ${n} 个断点`, "success");
          }}
        >
          <Icon name="trash" size={12} />
        </button>
      </div>

      {filtersOpen && (
        <div className="dbg-exc-pop">
          <div className="dbg-exc-title">异常断点</div>
          {availableFilters.length === 0 ? (
            <div className="dbg-empty">适配器没有提供异常断点过滤器。</div>
          ) : (
            availableFilters.map((f) => (
              <label key={f.filter} className="dbg-exc-item">
                <input
                  type="checkbox"
                  checked={enabledFilters.includes(f.filter)}
                  onChange={(e) => void setExceptionFilter(f.filter, e.target.checked)}
                />
                {f.label}
              </label>
            ))
          )}
          <button type="button" className="dbg-exc-close" onClick={() => setFiltersOpen(false)}>
            关闭
          </button>
        </div>
      )}

      {muted && (
        <div className="dbg-bp-muted">
          <Icon name="eyeOff" size={11} />
          已静音：{breakpoints.length} 个断点临时全部失效
          <button type="button" className="dbg-bp-muted-act" onClick={() => setMuted(false)}>
            取消静音
          </button>
        </div>
      )}

      <DebugBreakpointGroups
        groups={groups}
        onToggle={(name, on) => setBreakpointGroupEnabled(name, on)}
        onRename={(from, to) => {
          const moved = renameBreakpointGroup(from, to);
          if (moved < 0) toast(`组「${to.trim()}」已存在，换个名字`, "error");
          return moved;
        }}
        onDisband={(name) => {
          const n = clearBreakpointGroup(name);
          toast(`组「${name}」已解散：${n} 个断点回到默认组`, "success");
        }}
      />

      <div className="dbg-list">
        {breakpoints.length === 0 && (
          <div className="dbg-empty">还没有断点：在行号槽点击（或 Ctrl+F8）添加。</div>
        )}
        {fileGroups.map(([path, list]) => (
          <div key={path} className="dbg-bp-group">
            <div className="dbg-bp-file" title={path}>
              {baseName(path)}
            </div>
            {list.map((bp) => {
              const key = bpKey(bp.path, bp.line);
              const enabled = isBreakpointEnabledRow(bp);
              return (
                <div key={key}>
                  <div className="dbg-bp-row" data-off={!enabled || undefined}>
                    <input
                      type="checkbox"
                      className="dbg-bp-check"
                      checked={bp.enabled !== false}
                      title={bp.enabled !== false ? "禁用这个断点（不下发，也不停）" : "启用这个断点"}
                      onChange={(e) => updateBreakpointAt(bp.path, bp.line, { enabled: e.target.checked })}
                    />
                    <button
                      type="button"
                      className="dbg-bp-open"
                      title={`跳到 ${bp.path}:${bp.line}`}
                      onClick={() => onOpenAt(bp.path, bp.line)}
                    >
                      <span className="dbg-bp-line">行 {bp.line}</span>
                      <Badges bp={bp} />
                    </button>
                    <button
                      type="button"
                      className="dbg-icon-btn dbg-bp-act"
                      title="编辑条件 / 命中次数 / 日志消息 / 分组"
                      onClick={() => openEditor(bp)}
                    >
                      <Icon name="edit" size={11} />
                    </button>
                    <button
                      type="button"
                      className="dbg-icon-btn dbg-bp-act"
                      title="删除断点"
                      onClick={() => removeBreakpointAt(bp.path, bp.line)}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                  {draft?.key === key && (
                    <DebugBreakpointEditor
                      draft={draft}
                      groupNames={groups.map((g) => g.name)}
                      onChange={(patch) => setDraft({ ...draft, ...patch })}
                      onSave={() => save(bp)}
                      onCancel={() => setDraft(null)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 行是否点亮：单个禁用 / 组禁用 / 全局静音都算（视觉置灰，与 gutter 同一判据）。 */
function isBreakpointEnabledRow(bp: Breakpoint): boolean {
  return breakpointInactiveReason(bp) === null;
}
