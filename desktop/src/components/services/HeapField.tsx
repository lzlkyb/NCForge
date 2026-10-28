import { useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { formatHeapMb } from "../../lib/server";

/** 与 Rust `launch::HEAP_MIN_MB` / `HEAP_MAX_MB` 保持一致（后端是权威，这里只做提前拦截）。 */
const MIN_MB = 512;
const MAX_MB = 65536;

/** 快捷档：2G / 4G / 8G，覆盖绝大多数机器；4G 是默认值。 */
const PRESETS = [2048, 4096, 8192];

/**
 * 堆上限（`-Xmx`）：默认 4G，可就地改。
 *
 * 为什么不做成弹窗：它就是一个数，弹窗要多两次点击还要多点一次「确定」；
 * 就地编辑和旁边的 NC home / 工程路径一样，改完 Enter 就落盘。
 *
 * 为什么单位写 MB 而不是 G：后端存的是 MB，显示层再做换算。输入框里也写 MB，
 * 是为了让「4096」和配置里的数一眼对得上——同事手改 config.json 时不会差一个 1024 倍。
 */
export function HeapField({
  heapMb,
  defaultHeapMb,
  running,
  onSave,
}: {
  /** 当前生效值（后端收口后的，不是配置原值）。 */
  heapMb: number;
  defaultHeapMb: number;
  /** 服务是否在跑：改了要重启才生效，界面得说出来。 */
  running: boolean;
  /** 保存并返回后端生效值。传 null = 恢复默认 4G。 */
  onSave: (mb: number | null) => Promise<number>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async (mb: number | null) => {
    // 拦重复提交：Enter 连按、或 Enter 后马上点 ✓，会发出两个 server_heap_set。
    // 两个都是合法写，但第二次会把第一次的 toast 变成「保存成功」而实际以后一次为准，
    // 用户看到的生效值可能和手里那次输入不一致。禁用态只挡鼠标，挡不住键盘。
    if (saving) return;
    setSaving(true);
    try {
      const applied = await onSave(mb);
      setEditing(false);
      const label = mb === null ? `默认 ${formatHeapMb(applied)}` : formatHeapMb(applied);
      toast(`堆上限已设为 ${label}${running ? "，重启服务后生效" : ""}`, "success");
    } catch (e) {
      // 不吞错：后端会明确说「要在 512~65536 之间」或配置文件写不进去
      toast(String(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const submit = () => {
    if (saving) return;
    const mb = Number(draft.trim());
    if (!draft.trim() || !Number.isInteger(mb)) {
      toast("堆上限要填整数（单位 MB）", "error");
      return;
    }
    if (mb < MIN_MB || mb > MAX_MB) {
      toast(`堆上限要在 ${MIN_MB}~${MAX_MB} MB 之间，4G 填 4096`, "error");
      return;
    }
    void save(mb);
  };

  const restoreDefault = () => {
    void save(null);
  };

  if (editing) {
    return (
      <div className="sv-cfg-item sv-cfg-heap sv-cfg-item-edit">
        <span className="sv-cfg-k">堆上限</span>
        <input
          autoFocus
          className="sv-cfg-input sv-cfg-num"
          value={draft}
          inputMode="numeric"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, "").slice(0, 5))}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
        <span className="sv-cfg-unit">MB</span>
        <div className="sv-port-quick">
          {PRESETS.map((mb) => (
            <button key={mb} type="button" data-active={Number(draft) === mb} onClick={() => setDraft(String(mb))}>
              {mb / 1024}G
            </button>
          ))}
        </div>
        <button type="button" className="sv-icon-btn" disabled={saving} title="保存" onClick={submit}>
          <Icon name="check" size={14} />
        </button>
        <button type="button" className="sv-icon-btn" title="取消" onClick={() => setEditing(false)}>
          <Icon name="close" size={14} />
        </button>
      </div>
    );
  }

  const hint = heapMb === defaultHeapMb ? `默认 · -Xmx${heapMb}m` : `-Xmx${heapMb}m`;

  return (
    <div className="sv-cfg-item sv-cfg-heap">
      <span className="sv-cfg-k">堆上限</span>
      {/* 悬停说清三件事：这个数从哪来（启动参数 -Xmx）、什么时候生效（重启）、
          怎么回去（恢复默认）。和端口那处一个思路—— tooltip 是免费文档位 */}
      <span
        className="sv-cfg-v"
        title={`JVM 启动参数 -Xmx${heapMb}m${running ? "；改完要重启服务才生效（堆大小只能在启动时定）" : ""}`}
      >
        {formatHeapMb(heapMb)}
      </span>
      <span className="sv-cfg-hint" title={hint}>
        {hint}
      </span>
      <span className="sv-sp" />
      {heapMb !== defaultHeapMb && (
        <button type="button" className="sv-link" onClick={restoreDefault} title={`改回默认的 ${formatHeapMb(defaultHeapMb)}`}>
          恢复默认
        </button>
      )}
      <button
        type="button"
        className="sv-link"
        onClick={() => {
          setDraft(String(heapMb));
          setEditing(true);
        }}
      >
        修改
      </button>
    </div>
  );
}
