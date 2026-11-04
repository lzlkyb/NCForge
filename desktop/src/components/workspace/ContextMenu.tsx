import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../ui/icon";

export interface ContextMenuItem {
  label: string;
  icon?: IconName;
  /** 右侧的快捷键提示。 */
  hint?: string;
  /** 危险操作（删除），红色文字。 */
  danger?: boolean;
  disabled?: boolean;
  /** 在这一项之前画一条分隔线。 */
  separator?: boolean;
  onSelect: () => void;
}

/**
 * 在鼠标位置弹出的右键菜单。
 *
 * 与 `ui/Menu` 的区别：那个是「挂在某个按钮下面」的受控菜单，靠相对定位；
 * 右键菜单的锚点是鼠标坐标（可能落在任何地方），所以挂到 body 上用 fixed 定位，
 * 并按视口边界自动翻转，避免贴边时半个菜单在屏幕外。
 *
 * 关闭时机与系统菜单一致：点菜单外、Esc、滚动或改变窗口大小。
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const closeAndRestoreFocus = useCallback(() => {
    if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
    onClose();
  }, [onClose]);
  // 先按鼠标点渲染（不可见），量到真实尺寸后再纠正到不出界的位置，避免第一帧闪一下。
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const left = x + w + 8 > window.innerWidth ? Math.max(8, x - w) : x;
    const top = y + h + 8 > window.innerHeight ? Math.max(8, y - h) : y;
    setPos({ left, top });
  }, [x, y, items.length]);

  useEffect(() => {
    if (!returnFocus.current && document.activeElement instanceof HTMLElement) {
      returnFocus.current = document.activeElement;
    }
    // 打开就聚焦第一项：纯键盘用户（右键键 / Menu 键）不用再 Tab 一次，
    // 而且方向键的处理靠 activeElement 定位当前项。
    const first = boxRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    );
    first?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      // 外部按下会由浏览器把焦点交给目标；关闭菜单不能再抢回触发器。
      if (!boxRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeAndRestoreFocus();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const btns = Array.from(
        boxRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
      );
      if (!btns.length) return;
      e.preventDefault();
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? btns.length - 1
            : e.key === "ArrowDown"
              ? i < 0
                ? 0
                : (i + 1) % btns.length
              : i < 0
                ? btns.length - 1
                : (i <= 0 ? btns.length : i) - 1;
      btns[next].focus({ preventScroll: true });
    };
    const onLeave = () => closeAndRestoreFocus();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    // 捕获阶段：文件树自己的滚动会让菜单飘在错误的位置，直接关掉
    window.addEventListener("scroll", onLeave, true);
    window.addEventListener("resize", onLeave);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onLeave, true);
      window.removeEventListener("resize", onLeave);
    };
  }, [onClose, closeAndRestoreFocus]);

  return createPortal(
    <div
      ref={boxRef}
      role="menu"
      className="wb-ctx"
      style={{
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        visibility: pos ? undefined : "hidden",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <div key={item.label}>
          {item.separator && i > 0 && <div className="wb-ctx-sep" />}
          <button
            type="button"
            role="menuitem"
            className="wb-ctx-item"
            data-danger={item.danger || undefined}
            disabled={item.disabled}
            onClick={() => {
              closeAndRestoreFocus();
              item.onSelect();
            }}
          >
            {item.icon && <Icon name={item.icon} size={13} className="wb-ctx-icon" />}
            <span className="wb-ctx-label">{item.label}</span>
            {item.hint && <span className="wb-ctx-hint">{item.hint}</span>}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
