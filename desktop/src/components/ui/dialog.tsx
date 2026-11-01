import { type ReactNode } from "react";
import { Modal } from "./Modal";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /**
   * 读屏播报的对话框名。
   *
   * 不传的话打开的是一个「无名 dialog」——屏幕阅读器只会念 role，说不出这是
   * 「全部替换确认」还是别的什么。`Modal` 早就支持 ariaLabel，这里漏了透传。
   */
  ariaLabel?: string;
  zIndex?: number;
}

/**
 * 通用弹窗外壳。圆角/内距/标题字号与 ConfirmModal / ConfirmDialog 统一
 * （P2-5：曾经三套外壳——rounded-lg+p-6+text-lg / rounded-xl+p-5 /
 * rounded-xl+p-5+text-base——与 --r-card token 脱节，且 z-index 50 与 Modal
 * 默认 1000 两套阶梯，嵌在弹窗里的确认框会被父弹窗遮罩盖住）。
 * 现在一律：`var(--r-card)` 圆角 + p-5 + text-base 标题，层级跟 Modal 默认 1000。
 */
export function Dialog({ open, onClose, children, ariaLabel, zIndex }: DialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={ariaLabel}
      zIndex={zIndex}
      className="mx-4 w-full max-w-lg rounded-[var(--r-card)] modal-surface p-5"
    >
      {children}
    </Modal>
  );
}

export function DialogHeader({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mb-4 flex items-center justify-between ${className}`}>{children}</div>;
}

export function DialogTitle({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <h3 className={`text-base font-semibold ${className}`}>{children}</h3>;
}
