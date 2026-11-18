// 断点分组 chip 行：点 chip 整组启用/禁用，悬停出重命名/解散。
//
// 与清单分开一层：chip 行自己有「正在重命名哪个」的临时状态，
// 塞进 DebugBreakpoints.tsx 会把它推过 300 行门禁。
import { useState } from "react";
import { Icon } from "../ui/icon";
import type { BreakpointGroupInfo } from "../../lib/breakpointGroups";

export function DebugBreakpointGroups({
  groups,
  onToggle,
  onRename,
  onDisband,
}: {
  groups: BreakpointGroupInfo[];
  onToggle: (name: string, on: boolean) => void;
  /** 返回 -1 = 目标组名已被占用（UI 转告用户）。 */
  onRename: (from: string, to: string) => number;
  onDisband: (name: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const commit = () => {
    if (renaming && draft.trim()) onRename(renaming, draft);
    setRenaming(null);
    setDraft("");
  };

  if (groups.length === 0) return null;
  return (
    <div className="dbg-bp-groups">
      {groups.map((g) =>
        renaming === g.name ? (
          <input
            key={g.name}
            className="dbg-bp-gchip-rename"
            value={draft}
            autoFocus
            aria-label={`重命名组 ${g.name}`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setRenaming(null);
                setDraft("");
              }
            }}
            onBlur={commit}
          />
        ) : (
          <span
            key={g.name}
            className="dbg-bp-gchip"
            data-off={!g.enabled || undefined}
            title={`组「${g.name}」· ${g.count} 个断点 · 点击${g.enabled ? "禁用" : "启用"}整组`}
          >
            <button type="button" className="dbg-gchip-name" onClick={() => onToggle(g.name, !g.enabled)}>
              {g.name}
            </button>
            <span className="dbg-bp-gchip-count">{g.count}</span>
            <button
              type="button"
              className="dbg-icon-btn dbg-gchip-act"
              title="重命名组"
              onClick={() => {
                setRenaming(g.name);
                setDraft(g.name);
              }}
            >
              <Icon name="edit" size={10} />
            </button>
            <button
              type="button"
              className="dbg-icon-btn dbg-gchip-act"
              title="解散组（断点回到默认组，不删除断点）"
              onClick={() => onDisband(g.name)}
            >
              <Icon name="close" size={10} />
            </button>
          </span>
        ),
      )}
    </div>
  );
}
