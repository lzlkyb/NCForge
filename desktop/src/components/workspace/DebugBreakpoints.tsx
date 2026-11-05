// 调试面板右栏：断点清单 + 异常断点开关。
//
// 断点存在 `lib/breakpoints`（按工作区隔离），这里只改清单与触发语义；
// 下发由 `debugSync` 订阅清单变化完成，视图不直接碰适配器。
import { useMemo, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { baseName } from "../../lib/workspace";
import { useWorkspaceRoot } from "../../lib/workspaceSession";
import {
  bpKey,
  clearAllBreakpoints,
  isBreakpointEnabled,
  removeBreakpointAt,
  updateBreakpointAt,
  useBreakpoints,
  type Breakpoint,
} from "../../lib/breakpoints";
import type { ExceptionFilter } from "../../lib/debug";
import { setExceptionFilter } from "../../lib/debugSession";

interface Draft {
  key: string;
  condition: string;
  hitCondition: string;
  logMessage: string;
}

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
  const breakpoints = useBreakpoints(useWorkspaceRoot() ?? "");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const groups = useMemo(() => {
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
    });

  const save = (bp: Breakpoint) => {
    if (!draft) return;
    updateBreakpointAt(bp.path, bp.line, {
      condition: draft.condition,
      hitCondition: draft.hitCondition,
      logMessage: draft.logMessage,
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

      <div className="dbg-list">
        {breakpoints.length === 0 && (
          <div className="dbg-empty">还没有断点：在行号槽点击（或 Ctrl+F8）添加。</div>
        )}
        {groups.map(([path, list]) => (
          <div key={path} className="dbg-bp-group">
            <div className="dbg-bp-file" title={path}>
              {baseName(path)}
            </div>
            {list.map((bp) => {
              const key = bpKey(bp.path, bp.line);
              const enabled = isBreakpointEnabled(bp);
              return (
                <div key={key}>
                  <div className="dbg-bp-row" data-off={!enabled || undefined}>
                    <input
                      type="checkbox"
                      className="dbg-bp-check"
                      checked={enabled}
                      title={enabled ? "禁用这个断点（不下发，也不停）" : "启用这个断点"}
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
                      title="编辑条件 / 命中次数 / 日志消息"
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
                    <div className="dbg-bp-edit">
                      <label>
                        条件（Java 表达式）
                        <input
                          value={draft.condition}
                          placeholder="如 vo.getCode() != null"
                          spellCheck={false}
                          onChange={(e) => setDraft({ ...draft, condition: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") save(bp);
                            if (e.key === "Escape") setDraft(null);
                          }}
                        />
                      </label>
                      <label>
                        命中次数
                        <input
                          value={draft.hitCondition}
                          placeholder="如 5 / >=5 / %5"
                          spellCheck={false}
                          onChange={(e) => setDraft({ ...draft, hitCondition: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") save(bp);
                            if (e.key === "Escape") setDraft(null);
                          }}
                        />
                      </label>
                      <label>
                        日志消息（填了就不停）
                        <input
                          value={draft.logMessage}
                          placeholder="如 code = {vo.getCode()}"
                          spellCheck={false}
                          onChange={(e) => setDraft({ ...draft, logMessage: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") save(bp);
                            if (e.key === "Escape") setDraft(null);
                          }}
                        />
                      </label>
                      <div className="dbg-bp-edit-actions">
                        <button type="button" className="dbg-btn dbg-btn-primary" onClick={() => save(bp)}>
                          保存
                        </button>
                        <button type="button" className="dbg-btn" onClick={() => setDraft(null)}>
                          取消
                        </button>
                      </div>
                    </div>
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
