import { useEffect, useState, type ReactNode } from "react";
import { bindingRows, type BindingGroup, type Keymap } from "../../lib/keymap";
import {
  chordOfEvent,
  clearAllBindings,
  clearBindingOverride,
  setBindingOverride,
} from "../../lib/keybindings";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";

const GROUPS: BindingGroup[] = ["快速导航", "窗口", "搜索与层级", "编辑器"];

/**
 * 键位表 + 「按一下」采集。
 *
 * 采集期间用捕获阶段的 keydown 抢在窗口快捷键之前：否则想绑 Ctrl+B 时会先把侧栏切走。
 * 不合法（没有 Ctrl/Alt、与其它动作重复、Ctrl+S）只提示、不写入，保持原绑定可用。
 */
export function KeybindingEditor({ keymap }: { keymap: Keymap }) {
  const [capturing, setCapturing] = useState<string | null>(null);
  const [, bump] = useState(0);
  const rows = bindingRows(keymap);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      const chord = chordOfEvent(e);
      if (!chord) {
        toast("需要 Ctrl 或 Alt 加一个键（Esc 取消）", "warning");
        return;
      }
      const conflict = bindingRows(keymap).find((r) => r.id !== capturing && r.keys.includes(chord));
      if (conflict) {
        toast(`该组合已用于「${conflict.label}」`, "warning");
        return;
      }
      const r = setBindingOverride(capturing, chord);
      if (!r.ok) {
        toast(r.error, "error");
        return;
      }
      setCapturing(null);
      bump((n) => n + 1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, keymap]);

  const resetOne = (id: string) => {
    clearBindingOverride(id);
    bump((n) => n + 1);
  };

  const resetAll = () => {
    clearAllBindings();
    bump((n) => n + 1);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <h2 className="font-medium">自定义键位</h2>
        <span className="text-sm text-muted-foreground">
          {capturing ? "现在按下新组合键，Esc 取消" : "点「修改」后直接按组合键"}
        </span>
        <span className="grow" />
        {rows.some((r) => r.overridden) && (
          <Button size="sm" variant="ghost" onClick={resetAll}>
            全部恢复默认
          </Button>
        )}
      </div>
      <table className="wb-keymap-table">
        <tbody>
          {GROUPS.map((group) => {
            const list = rows.filter((r) => r.group === group);
            if (list.length === 0) return null;
            return (
              <FragmentRows key={group} group={group}>
                {list.map((r) => (
                  <tr key={r.id} data-capturing={capturing === r.id || undefined}>
                    <td>{r.label}</td>
                    <td>
                      <kbd>{r.display.length > 0 ? r.display.join(" / ") : "—"}</kbd>
                    </td>
                    <td className="whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setCapturing(capturing === r.id ? null : r.id)}
                      >
                        {capturing === r.id ? "按键…" : "修改"}
                      </Button>
                      {r.overridden && (
                        <Button size="sm" variant="ghost" onClick={() => resetOne(r.id)}>
                          恢复
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </FragmentRows>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 分组标题行；用 Fragment 包着是为了不额外引入一个组件文件。 */
function FragmentRows({ group, children }: { group: BindingGroup; children: ReactNode }) {
  return (
    <>
      <tr>
        <th colSpan={3}>{group}</th>
      </tr>
      {children}
    </>
  );
}
