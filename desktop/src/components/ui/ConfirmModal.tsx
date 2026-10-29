import type { ReactNode } from "react";
import { Modal } from "./Modal";

interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** 内容卡片最大宽度，默认 md（与原自建确认弹窗一致） */
  maxWidth?: "sm" | "md" | "lg";
  /**
   * 层级，默认 1000（与 Modal 默认一致，P2-5 统一阶梯）。
   *
   * **嵌在另一个弹框里时必须传更大的值**：两者都 portal 到 body、是兄弟节点，
   * 不抬层级的话确认框会被盖在父弹框的遮罩下面：看不见也点不到，
   * 而点击会落到父弹框遮罩上把父弹框关掉。
   */
  zIndex?: number;
}

/**
 * 确认型弹窗统一外壳：遮罩 + 居中 + 点击遮罩关闭 + 内容卡片。
 * 现基于统一 <Modal> 原语（动画质感升级），获得进出场过渡；调用方若用条件渲染控制显隐，
 * 进出场由父级挂载/卸载驱动；若用 open 受控，则自带退场动画。
 */
export function ConfirmModal({
  open,
  onClose,
  children,
  maxWidth = "md",
  zIndex = 1000,
}: ConfirmModalProps) {
  const maxW =
    maxWidth === "sm" ? "max-w-sm" : maxWidth === "lg" ? "max-w-lg" : "max-w-md";
  return (
    <Modal open={open} onClose={onClose} zIndex={zIndex} className={`mx-4 w-full ${maxW} rounded-[var(--r-card)] modal-surface p-5`}>
      {children}
    </Modal>
  );
}
