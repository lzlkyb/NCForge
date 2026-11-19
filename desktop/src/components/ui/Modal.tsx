/**
 * 弹层底层原语 —— 全站唯一实现。**不是被替代的旧组件。**
 *
 * 2026-11-17 更正：此前这里标着 `@deprecated`，并把 `Modal` / `Dialog` 说成
 * 「两代弹层并存」。真正读过 `./dialog` 才发现 `Dialog` 只是 `Modal` 加一套固定样式
 * （`--w-modal-sm` + `p-5` + `--r-card`）—— 两者是「原语 / 预设」关系，
 * 不存在谁替代谁。那条废弃标记和导入棘轮一直在逼新代码走等价路径，已撤。
 *
 * 真正的债是**宽度**：迁移前全站弹层实测 16 种宽度（360…1120），分散在
 * Tailwind `max-w-*` / 类里写死 px / `min()` / tsx 内联 `w-[NNNpx]` 四套体系。
 * 现已统一到 index.css「档位五 · 弹层宽度」的 `--w-modal-xs|sm|md|lg|xl|2xl`，
 * 由 `npm run tokens:check` 强制（`scripts/lib/modal-width.mjs`）。
 *
 * 新代码怎么选：
 *   · 小确认框 / 单字段表单 → 直接用 `./dialog` 的 `Dialog`（它就是 sm 档预设）
 *   · 其余尺寸 → 用 `Modal`，className 里挑一个 `w-[var(--w-modal-*)]`
 *
 * 迁移时仍需留意的两件事：
 *   1) 嵌套弹层的 zIndex —— Dialog 与 Modal 默认都是 1000，同层会抢焦点；
 *   2) `ariaLabel` 必须显式给，否则读屏只念 role、说不出这是哪个对话框。
 */
import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePresence } from "../../hooks/usePresence";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useViewActive } from "../../lib/viewActivity";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** 内容卡片 className（尺寸/圆角/表面由调用方指定，沿用 modal-surface） */
  className?: string;
  /** overlay 额外 className */
  overlayClassName?: string;
  /** 点击遮罩是否关闭，默认 true */
  closeOnOverlay?: boolean;
  /** 执行会话在工具页切后台时保留子组件，弹层隐藏且释放焦点；关闭后仍正常卸载。 */
  keepMountedWhenInactive?: boolean;
  /** scale 保留历史调用值，现使用轻位移；fade 只淡入，避免文字缩放。 */
  animation?: "scale" | "fade";
  /** 层级，默认 1000（原 UpdateNotesDialog/VersionHistoryModal 用 1000，Dialog 用 50） */
  zIndex?: number;
  ariaLabel?: string;
}

/**
 * 统一弹窗原语（动画质感升级 · 方案 C）。
 *
 * 解决「弹窗只有进场、关闭硬消失」的质感缺口：
 *  - 进场：遮罩淡入 + 内容轻位移，文字保持原尺寸
 *  - 退场：视觉结束后卸载，交互与焦点在关闭时即释放
 *  - Esc / 点遮罩 / 关闭按钮统一关闭（调用方只需接 onClose）
 *  - 通过 createPortal 挂到 document.body，避免祖先层叠上下文影响 fixed 定位
 *  - 用户开启「减弱动效」时：退场延时归零、过渡即时（与全局守卫一致）
 *
 * 调用方改写指引：删除自身的 `if (!open) return null` 与遮罩/退场相关代码，
 * 把内容包进 <Modal open={open} onClose={onClose} className="原有的 surface 类">。
 */
export function Modal({
  open,
  onClose,
  children,
  className = "",
  overlayClassName = "",
  closeOnOverlay = true,
  keepMountedWhenInactive = false,
  animation = "scale",
  zIndex = 1000,
  ariaLabel,
}: ModalProps) {
  const active = useViewActive();
  const visible = open && active;
  const retained = open && !active && keepMountedWhenInactive;
  const { mounted, entered } = usePresence(visible);
  // 焦点陷阱（a11y）：Tab 环绕在弹窗内、关闭后焦点归还触发元素。
  // 视觉退场继续播放，焦点与交互随 visible 立即释放。
  // Esc 在内容节点处理并停止冒泡，嵌套弹窗优先关闭自己。
  const surfaceRef = useRef<HTMLDivElement>(null);
  /**
   * 按下 / 抬起时指针是否都在遮罩上。
   *
   * 只看 click 的 target 不够：mousedown 在弹窗内、mouseup 落在遮罩上（或反过来），
   * click 的 target 都是两者的公共祖先——也就是遮罩本身。导入配置、全部替换这类含
   * 不可逆操作的确认框，会因为在框里拖选文字、手松到外面就「莫名关掉」。
   * 两个方向都要求按下与抬起同时落在遮罩上，才允许关闭。
   */
  const downOnOverlay = useRef(false);
  const upOnOverlay = useRef(false);
  useFocusTrap(surfaceRef, { enabled: visible, onEscape: visible ? onClose : undefined });

  if (!mounted && !retained) return null;

  return createPortal(
    <div
      className={`ui-overlay fixed inset-0 flex items-center justify-center bg-black/45 ${overlayClassName}`}
      data-state={entered ? "open" : "closed"}
      data-exiting={!visible || undefined}
      style={{ zIndex, display: retained ? "none" : undefined }}
      aria-hidden={!visible || undefined}
      data-view-inactive={!visible || undefined}
      // 页面切后台保留的弹层：display:none 之外再置 inert，确保它不接收焦点、不进读屏。
      ref={(node) => { if (node) node.inert = !visible; }}
      onMouseDown={(e) => {
        downOnOverlay.current = e.target === e.currentTarget;
        upOnOverlay.current = false;
      }}
      onMouseUp={(e) => {
        upOnOverlay.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (!visible || !closeOnOverlay) return;
        if (!downOnOverlay.current || !upOnOverlay.current || e.target !== e.currentTarget) return;
        onClose();
      }}
    >
      <div
        ref={surfaceRef}
        role="dialog" aria-modal="true" aria-label={ariaLabel}
        data-state={entered ? "open" : "closed"}
        data-exiting={!visible || undefined}
        data-motion={animation}
        className={`ui-surface mx-4 ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
