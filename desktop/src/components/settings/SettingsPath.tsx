import { useState } from "react";
import { Button } from "../ui/button";
import { copyText } from "../../lib/utils";

/** Paths stay readable and copyable even when a narrow pane wraps them. */
export function SettingsPath({ value, label, empty = "未设置" }: { value?: string | null; label: string; empty?: string }) {
  const [feedback, setFeedback] = useState<{ value: string; error?: boolean; text: string }>();
  return <div className="settings-path-readout">
    <code title={value || undefined}>{value || empty}</code>
    {value && <Button size="sm" variant="ghost" aria-label={`复制${label}`} onClick={() => void copyText(value,
      () => setFeedback({ value, text: "路径已复制" }),
      () => setFeedback({ value, error: true, text: "无法复制，请选中完整路径手动复制。" }),
    )}>复制路径</Button>}
    {feedback && feedback.value === value && <span className={feedback.error ? "settings-inline-error" : "settings-help"} role={feedback.error ? "alert" : "status"}>{feedback.text}</span>}
  </div>;
}
