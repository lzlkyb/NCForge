import type { ReactNode } from "react";

/**
 * 范围切换的小圆角按钮（样式与文件过滤预设一致）。
 *
 * 从 `SearchBar` 抽出来是因为「组件」那个范围要包一层菜单：触发器与菜单项分居
 * 两个文件，共用一份样式比复制一遍 class 串可靠。
 */
export function ScopeChip({
  on,
  disabled,
  onClick,
  title,
  expanded,
  hasPopup,
  children,
}: {
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  /** 展开态（菜单触发器用），只影响无障碍属性。 */
  expanded?: boolean;
  hasPopup?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      aria-expanded={hasPopup ? expanded : undefined}
      aria-haspopup={hasPopup ? "menu" : undefined}
      title={title}
      className={`h-6 rounded-full border px-2 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        on
          ? "border-primary/40 bg-primary/10 font-semibold text-primary"
          : "border-border text-muted-foreground hover:bg-muted"
      }`}
    >
      {children}
    </button>
  );
}
