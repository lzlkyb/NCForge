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
 * 「通用小弹窗」预设 —— 本质是 `Modal` + 一套固定样式，不是它的替代品。
 *
 * 2026-11-17 更正：曾经把这里当「新一代弹层」，于是弹层收敛变成「53 处 Modal 改
 * Dialog」。实际读代码后确认：`Dialog` 只是把 `max-w-lg` + `p-5` + `--r-card`
 * 打包好，尺寸表达不了 `max-w-3xl/4xl` 的大面板。逐处替换会把 38 个模块私有类
 * 的尺寸全压成 sm 档，直接压坏数据库页与元数据页的弹窗。
 *
 * 定位：宽度档位里的 **sm**（`--w-modal-sm`，460px）。要别的尺寸就直接用 `Modal`
 * 并挑档位，不要给 Dialog 加 className 参数去开新口子。
 *
 * 圆角/内距与 `ConfirmDialog` 统一（P2-5：曾经三套外壳——rounded-lg+p-6+text-lg /
 * rounded-xl+p-5 / rounded-xl+p-5+text-base——与 `--r-card` 脱节，
 * 且 z-index 50 与 Modal 默认 1000 两套阶梯，嵌在弹窗里的确认框会被父弹窗遮罩盖住）。
 */
export function Dialog({ open, onClose, children, ariaLabel, zIndex }: DialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={ariaLabel}
      zIndex={zIndex}
      className="w-[var(--w-modal-sm)] rounded-[var(--r-card)] modal-surface p-5"
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
