import { useLayoutEffect, useRef, type ButtonHTMLAttributes } from "react";

const base = "ui-button inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[12px] font-medium disabled:pointer-events-none disabled:opacity-[var(--disabled-opacity,.62)]";

const variants = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  outline: "border border-input bg-transparent hover:bg-accent hover:text-accent-foreground",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ghost: "hover:bg-accent hover:text-accent-foreground",
  link: "text-primary underline-offset-4 hover:underline",
};

const sizes = {
  default: "h-[var(--h-control,30px)] px-3 py-1",
  sm: "h-[var(--h-icon,28px)] px-2.5 text-xs",
  lg: "h-9 px-5",
  icon: "h-[var(--h-icon,28px)] w-[var(--h-icon,28px)]",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  isLoading?: boolean;
  loadingText?: string;
}

export function Button({
  variant = "default",
  size = "default",
  className = "",
  isLoading,
  loadingText,
  children,
  disabled,
  style,
  ...props
}: ButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const widthRef = useRef<number>();
  // Header 等调用方会在 busy 时移除 children；保留上一帧宽度仍然必要。
  useLayoutEffect(() => {
    if (!isLoading && buttonRef.current) widthRef.current = buttonRef.current.getBoundingClientRect().width;
  }, [isLoading, children]);
  return (
    <button
      ref={buttonRef}
      aria-busy={isLoading || undefined}
      data-loading={isLoading || undefined}
      data-variant={variant}
      data-size={size}
      style={{ minWidth: isLoading ? widthRef.current : undefined, ...style }}
      className={`${base} relative overflow-hidden ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled || isLoading}
      {...props}
    >
      {/* 原内容保留尺寸，异步态覆盖其上，避免 spinner 插入时挤动相邻控件。 */}
      <span aria-hidden={isLoading || undefined} style={{ gap: "inherit" }} className={`inline-flex items-center justify-center ${isLoading ? "invisible" : ""}`}>{children}</span>
      {isLoading && <span className="ui-button-loader absolute inset-0 inline-flex min-w-0 items-center justify-center gap-2 px-2" role="status">
        <svg aria-hidden="true" className="animate-spin shrink-0" viewBox="0 0 24 24" width={size === "sm" ? 14 : 16} height={size === "sm" ? 14 : 16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <path d="M21 12a9 9 0 1 1-6.22-8.56" />
        </svg>
        {size === "icon" ? <span className="sr-only">{loadingText ?? "处理中"}</span> : <span className="truncate">{loadingText ?? "处理中…"}</span>}
      </span>}
    </button>
  );
}
