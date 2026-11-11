import { useEffect, useRef, type RefObject } from "react";
import { isImeComposing } from "../lib/utils";

interface FocusTrapOptions {
  /**
   * 是否启用。弹窗内容是延迟挂载的（如 `Modal` 的退场动画卸载）时，
   * 以 mounted 状态传入——enabled 翻转会让 effect 重跑，拿到真正挂上的节点。
   */
  enabled?: boolean;
  /**
   * Esc 处理。传了才接管 Esc（node 级监听 + stopPropagation，嵌套弹窗时
   * 确认框优先关自己）；不传则 Esc 完全留给调用方自己的监听（如 Modal 的
   * window 级关闭），陷阱只管 Tab 环与焦点归还。
   */
  onEscape?: () => void;
}

/**
 * 弹窗焦点陷阱（a11y）：挂载时聚焦首个可聚焦元素，Tab/Shift+Tab 在弹窗内循环
 * （Tab 不再「掉出」遮罩跑到背景内容上），卸载时把焦点归还给打开前的元素。
 *
 * 从 ConfirmDialog.tsx 的成熟实现抽出（设计稿《日志页-a11y键盘交互》：一处实现
 * 两处受益），ConfirmDialog 与 Modal 共用。onEscape 的取舍见其 doc。
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  opts: FocusTrapOptions = {},
): void {
  const { enabled = true, onEscape } = opts;
  // onEscape 走 ref：调用方普遍传内联箭头函数，入 effect 依赖会随父组件每次
  // 重渲染重跑，反复把焦点抢回第一个元素（ConfirmDialog 原实现的同款教训）。
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    const node = ref.current;
    if (!enabled || !node) return;
    const prev = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(node.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )).filter(el => el.tabIndex >= 0 && !el.matches(":disabled") && !el.closest("[inert]") && el.getClientRects().length > 0);
    const list = focusables();
    // 默认焦点交给第一个可聚焦元素，但高危确认框里的第一个往往是复选框或
    // 「10 分钟内不再询问」这类「顺手一按就改语义」的控件。带 `data-autofocus`
    // 的元素优先，让调用方把焦点钉在「取消」上。
    const preferred = node.querySelector<HTMLElement>("[data-autofocus]");
    (preferred && list.includes(preferred) ? preferred : list[0])?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      // IME 组词中的 Esc 属于输入法（收候选窗），不触发关闭——
      // Modal / ConfirmDialog / CommandPalette 内都有中文输入场景。
      if (isImeComposing(e)) return;
      if (e.key === "Escape" && escapeRef.current) {
        e.stopPropagation();
        escapeRef.current();
        return;
      }
      // 只有 Tab 需要知道焦点环里有哪些元素：别为每个按键都扫一遍 DOM + 量布局
      // （弹窗控件多时，输入/方向键都会白扫一遍）。
      if (e.key !== "Tab") return;
      const controls = focusables();
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    node.addEventListener("keydown", onKey);
    return () => {
      node.removeEventListener("keydown", onKey);
      // A drawer action can deliberately focus the newly revealed document.
      const active = document.activeElement;
      if (prev?.isConnected && (node.contains(active) || active === document.body || !active)) {
        // preventScroll 只是避开退场动画期间的跳转；焦点必须落在看得见的地方，
        // 否则键盘用户回到一个屏幕外的元素上，后续 Tab 从看不见的位置开始。
        prev.focus({ preventScroll: true });
        const box = prev.getBoundingClientRect();
        const visible = box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth;
        if (!visible) prev.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    };
  }, [ref, enabled]);
}
