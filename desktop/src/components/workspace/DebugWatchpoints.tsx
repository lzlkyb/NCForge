// 调试面板的字段观察点清单（watchpoint）。
//
// 与断点清单平行：清单在 `lib/watchpoints`（按工作区隔离），下发由
// `watchpointSync` 订阅完成。入口是变量行上的「眼睛」按钮（`DebugVariables`）——
// dataId 只能暂停时从适配器问出来；这里管清单本身：访问类型循环
// （读 → 写 → 读写）、启用/禁用、条件编辑、删除、整列清空。
//
// verified 状态来自适配器上一次 `setDataBreakpoints` 的回报（按请求顺序回映射），
// 用版本号订阅触发重渲染——与断点 gutter 同一套路。
import { useSyncExternalStore, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { useWorkspaceRoot } from "../../lib/workspaceSession";
import {
  accessTypeLabel,
  clearAllWatchpoints,
  cycleWatchpointAccess,
  isWatchpointEnabled,
  removeWatchpoint,
  setWatchpointEnabled,
  updateWatchpoint,
  useWatchpoints,
  watchpointDisplay,
  type Watchpoint,
} from "../../lib/watchpoints";
import {
  getWatchpointVerifiedVersion,
  isWatchpointVerified,
  subscribeWatchpointVerified,
} from "../../lib/watchpointSync";
import { validateCondition, validateHitCondition } from "../../lib/breakpointCondition";

/** 行内条件编辑器：条件 + 命中次数，保存前按适配器语义静态校验。 */
function WatchpointEditor({ w, onDone }: { w: Watchpoint; onDone: () => void }) {
  const [condition, setCondition] = useState(w.condition ?? "");
  const [hitCondition, setHitCondition] = useState(w.hitCondition ?? "");
  const condError = validateCondition(condition);
  const hitError = validateHitCondition(hitCondition);
  const invalid = condError !== null || hitError !== null;
  const save = () => {
    updateWatchpoint(w.dataId, { condition, hitCondition });
    onDone();
  };
  return (
    <div className="dbg-bp-edit">
      <label className="dbg-bp-field" data-err={condError ? "true" : undefined}>
        <span className="dbg-bp-field-label">条件（命中时才编译，为假不停）</span>
        <input
          value={condition}
          spellCheck={false}
          placeholder="如 vo.getCode() != null"
          onChange={(e) => setCondition(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && !invalid) save();
            if (e.key === "Escape") onDone();
          }}
        />
        {condError && <span className="dbg-bp-field-err">{condError}</span>}
      </label>
      <label className="dbg-bp-field" data-err={hitError ? "true" : undefined}>
        <span className="dbg-bp-field-label">命中次数（第 N 次命中才停，只支持正整数）</span>
        <input
          value={hitCondition}
          spellCheck={false}
          placeholder="如 5"
          onChange={(e) => setHitCondition(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && !invalid) save();
            if (e.key === "Escape") onDone();
          }}
        />
        {hitError && <span className="dbg-bp-field-err">{hitError}</span>}
      </label>
      <div className="dbg-bp-edit-actions">
        <button type="button" className="dbg-btn dbg-btn-primary" disabled={invalid} title={invalid ? "有字段不合法：先按红色提示修正" : undefined} onClick={save}>
          保存
        </button>
        <button type="button" className="dbg-btn" onClick={onDone}>
          取消
        </button>
      </div>
    </div>
  );
}

export function DebugWatchpoints() {
  const items = useWatchpoints(useWorkspaceRoot() ?? "");
  const [editing, setEditing] = useState<string | null>(null);
  // verified 变化靠版本号订阅：不订阅的话「装没装上」要等下次清单变化才刷新
  useSyncExternalStore(subscribeWatchpointVerified, getWatchpointVerifiedVersion, getWatchpointVerifiedVersion);

  return (
    <div className="dbg-bp-col">
      <div className="dbg-col-h">
        字段观察点
        {items.length > 0 && <span>· {items.length}</span>}
        <span className="dbg-sp" />
        <button
          type="button"
          className="dbg-icon-btn dbg-hd-btn"
          disabled={items.length === 0}
          title="清空当前工作区的全部观察点"
          onClick={() => {
            const n = items.length;
            clearAllWatchpoints();
            toast(`已清除 ${n} 个观察点`, "success");
          }}
        >
          <Icon name="trash" size={12} />
        </button>
      </div>

      <div className="dbg-list">
        {items.length === 0 && (
          <div className="dbg-empty">
            还没有字段观察点：暂停后展开对象，点字段行上的眼睛图标添加（字段被读写时会停下）。
          </div>
        )}
        {items.map((w) => {
          const enabled = isWatchpointEnabled(w);
          const verified = isWatchpointVerified(w.dataId);
          return (
            <div key={w.dataId}>
              <div className="dbg-bp-row" data-off={!enabled || undefined}>
                <input
                  type="checkbox"
                  className="dbg-bp-check"
                  checked={enabled}
                  title={enabled ? "禁用这个观察点（不下发，也不停）" : "启用这个观察点"}
                  onChange={(e) => setWatchpointEnabled(w.dataId, e.target.checked)}
                />
                <span className="dbg-wp-name" data-ok={verified || undefined} title={`${w.dataId}${verified ? "" : "（尚未装上：类未加载或字段不存在）"}`}>
                  <span className="dbg-wp-dot" data-ok={verified || undefined} />
                  {watchpointDisplay(w.dataId)}
                </span>
                {w.condition && (
                  <span className="dbg-bp-badge" title={`条件：${w.condition}`}>
                    条件
                  </span>
                )}
                {w.hitCondition && (
                  <span className="dbg-bp-badge" title={`命中次数：${w.hitCondition}`}>
                    #{w.hitCondition}
                  </span>
                )}
                <button
                  type="button"
                  className="dbg-wp-access"
                  data-kind={w.accessType}
                  title={`观察 ${accessTypeLabel(w.accessType)}（点击切换：读 → 写 → 读写）`}
                  onClick={() => {
                    const next = cycleWatchpointAccess(w.dataId);
                    if (next) toast(`已切换为「${accessTypeLabel(next)}」`, "success");
                  }}
                >
                  {accessTypeLabel(w.accessType)}
                </button>
                <button
                  type="button"
                  className="dbg-icon-btn dbg-bp-act"
                  title="编辑条件 / 命中次数"
                  onClick={() => setEditing(editing === w.dataId ? null : w.dataId)}
                >
                  <Icon name="edit" size={11} />
                </button>
                <button
                  type="button"
                  className="dbg-icon-btn dbg-bp-act"
                  title="删除观察点"
                  onClick={() => {
                    removeWatchpoint(w.dataId);
                    if (editing === w.dataId) setEditing(null);
                  }}
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
              {editing === w.dataId && (
                <WatchpointEditor w={w} onDone={() => setEditing(null)} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
