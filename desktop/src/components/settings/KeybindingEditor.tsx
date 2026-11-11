import { useEffect, useRef, useState, type ReactNode } from "react";
import { bindingRows, type BindingGroup, type Keymap } from "../../lib/keymap";
import {
  chordOfEvent,
  clearAllBindings,
  clearBindingOverride,
  setBindingOverride,
  RESERVED_CHORDS,
} from "../../lib/keybindings";
import { useSettingsRequest } from "../../lib/settingsJump";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";
import { ConfirmDialog } from "../ui/ConfirmDialog";

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
  const [message, setMessage] = useState<{ id: string; text: string; conflictId?: string }>();
  const [resetOpen, setResetOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const rows = bindingRows(keymap);
  // 快捷键一览里点「修改」会带着键位 id 跳到这里：直接进入采集态，
  // 不用在设置页再找一遍那一行。
  const jump = useSettingsRequest();
  const jumpId = jump?.binding;
  const jumpNonce = jump?.nonce;
  const consumedNonce = useRef<number | undefined>(undefined);
  useEffect(() => {
    // 同一 nonce 只武装一次：切键位方案会重跑 effect，不能把已取消的采集再拉起来。
    if (!jumpId || consumedNonce.current === jumpNonce) return;
    consumedNonce.current = jumpNonce;
    if (bindingRows(keymap).some((r) => r.id === jumpId)) setCapturing(jumpId);
  }, [jumpId, jumpNonce, keymap]);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      if (host.current?.closest("[hidden]")) { setCapturing(null); return; }
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      const chord = chordOfEvent(e);
      if (!chord) {
        setMessage({ id: capturing, text: "需要 Ctrl 或 Alt 加一个键（Esc 取消）。" });
        return;
      }
      if (RESERVED_CHORDS.has(chord)) {
        const result = setBindingOverride(capturing, chord);
        if (!result.ok) setMessage({ id: capturing, text: result.error });
        return;
      }
      const conflict = bindingRows(keymap).find((r) => r.id !== capturing && r.keys.includes(chord));
      if (conflict) {
        setMessage({ id: capturing, text: `该组合已用于「${conflict.label}」，请使用其他组合。`, conflictId: conflict.id });
        return;
      }
      const r = setBindingOverride(capturing, chord);
      if (!r.ok) {
        setMessage({ id: capturing, text: r.error });
        return;
      }
      setCapturing(null);
      setMessage(undefined);
      bump((n) => n + 1);
    };
    // Mounted settings pages retain drafts; a hidden page must release global key capture.
    const observer = new MutationObserver(() => {
      if (host.current?.closest("[hidden]")) setCapturing(null);
    });
    let ancestor: HTMLElement | null = host.current;
    while (ancestor) { observer.observe(ancestor, { attributes: true, attributeFilter: ["hidden"] }); ancestor = ancestor.parentElement; }
    window.addEventListener("keydown", onKey, true);
    return () => { observer.disconnect(); window.removeEventListener("keydown", onKey, true); };
  }, [capturing, keymap]);

  const resetOne = (id: string) => {
    if (!clearBindingOverride(id)) { setMessage({ id, text: "恢复失败：本机存储不可写，请重试。" }); return; }
    setMessage(undefined);
    bump((n) => n + 1);
  };

  const resetAll = () => {
    setResetOpen(false);
    if (!clearAllBindings()) { toast("恢复失败：本机存储不可写，原绑定仍然保留。", "error"); return; }
    setMessage(undefined);
    bump((n) => n + 1);
  };

  return (
    <div ref={host} className="flex flex-col gap-2">
      <div className="settings-keybinding-head flex items-center gap-3">
        <h2 className="font-medium">自定义键位</h2>
        <span className="text-sm text-muted-foreground">
          {capturing ? "现在按下新组合键，Esc 取消" : "点「修改」后直接按组合键"}
        </span>
        <span className="grow" />
        {rows.some((r) => r.overridden) && (
          <Button size="sm" variant="ghost" onClick={() => { setCapturing(null); setResetOpen(true); }}>
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
                  <tr key={r.id} id={`binding-${r.id}`} tabIndex={-1} data-settings-item="" data-settings-label={r.label} data-settings-description={`${group} · 点击修改后按组合键`} data-setting-value={r.display.join(" / ") || "未绑定"} data-capturing={capturing === r.id || undefined}>
                    <td>{r.label}</td>
                    <td className="settings-keybinding-key">
                      <kbd>{r.display.length > 0 ? r.display.join(" / ") : "—"}</kbd>
                      {capturing === r.id && <p className="settings-help" role="status">请按新组合键，Esc 取消</p>}
                      {message?.id === r.id && <p className="settings-inline-error" role="alert">{message.text}
                        {message.conflictId && <Button size="sm" variant="ghost" onClick={() => {
                          setCapturing(null);
                          document.getElementById(`binding-${message.conflictId}`)?.scrollIntoView({ block: "center" });
                          document.getElementById(`binding-${message.conflictId}`)?.focus();
                        }}>查看冲突命令</Button>}
                      </p>}
                    </td>
                    <td className="settings-keybinding-actions whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`修改${r.label}快捷键`}
                        onClick={() => { setMessage(undefined); setCapturing(capturing === r.id ? null : r.id); }}
                      >
                        {capturing === r.id ? "按键…" : "修改"}
                      </Button>
                      {r.overridden && (
                        <Button size="sm" variant="ghost" aria-label={`恢复${r.label}快捷键`} onClick={() => resetOne(r.id)}>
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
      <ConfirmDialog open={resetOpen} title="恢复全部自定义快捷键？" description={`将恢复 ${rows.filter(row => row.overridden).length} 个自定义绑定，保留当前快捷键方案。`}
        confirmLabel="恢复默认" onCancel={() => setResetOpen(false)} onConfirm={resetAll} />
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
