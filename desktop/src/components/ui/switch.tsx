/**
 * 轻量开关组件（无依赖）。用于设置页功能开关。
 * variant="danger" 时打开态用危险色（白名单关闭这类高风险开关）。
 *
 * `disabledReason`（P2-12）：disabled 时必须说清在等什么——悬停 title 是
 * 最轻的解释位（SearchBar 的 Toggle 同款正例）。不传则只降不解释。
 */
export function Switch({
  checked,
  onChange,
  variant = "default",
  disabled = false,
  disabledReason,
  ariaLabel,
  ariaDescribedBy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  variant?: "default" | "danger";
  disabled?: boolean;
  /** disabled 的原因说明（悬停显示）。 */
  disabledReason?: string;
  ariaLabel?: string;
  ariaDescribedBy?: string;
}) {
  const onColor = variant === "danger" ? "bg-destructive" : "bg-primary";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      title={disabled && disabledReason ? disabledReason : undefined}
      onClick={() => onChange(!checked)}
      className={`sw ${checked ? "on" : ""} ${variant === "danger" ? "danger" : ""} relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? onColor : "bg-input"
      }`}
    >
      <span
        className="sw-thumb inline-block h-5 w-5 rounded-full bg-white shadow"
      />
    </button>
  );
}
