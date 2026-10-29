import { useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";

/**
 * 一行「标签 + 路径 + 更换」。编辑态就地把路径换成输入框，不弹窗——
 * 路径是短字符串，用系统目录选择框要跨插件、还要处理取消语义，输入更快。
 */
export function PathField({
  label,
  value,
  placeholder,
  hint,
  onSave,
}: {
  label: string;
  value: string;
  placeholder: string;
  hint?: string;
  /** 返回 `"cancelled"` 表示保存被前置守卫拦下（如运行中切换需确认而用户取消）。 */
  onSave: (v: string) => Promise<void | "cancelled">;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const outcome = await onSave(draft.trim());
      // 取消（比如运行中切换要确认、用户点了取消）：保持编辑态，让用户接着改，
      // 关掉输入框会让人以为保存成功了。
      if (outcome === "cancelled") return;
      setEditing(false);
    } catch (e) {
      // 保存失败必须可见：路径错一个字母就会起不来服务，而错误文案往往能直接指出缺什么
      toast(String(e), "error");
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="sv-cfg-item sv-cfg-item-edit">
        <span className="sv-cfg-k">{label}</span>
        <input
          autoFocus
          className="sv-cfg-input"
          value={draft}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") setEditing(false);
          }}
        />
        <button type="button" className="sv-icon-btn" disabled={saving} title="保存" onClick={() => void save()}>
          <Icon name="check" size={14} />
        </button>
        <button type="button" className="sv-icon-btn" title="取消" onClick={() => setEditing(false)}>
          <Icon name="close" size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="sv-cfg-item">
      <span className="sv-cfg-k">{label}</span>
      <span className="sv-cfg-v" title={value || placeholder}>
        {value || <span className="sv-cfg-empty">{placeholder}</span>}
      </span>
      {hint && (
        <span className="sv-cfg-hint" title={hint}>
          {hint}
        </span>
      )}
      <span className="sv-sp" />
      <button
        type="button"
        className="sv-link"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        更换
      </button>
    </div>
  );
}
