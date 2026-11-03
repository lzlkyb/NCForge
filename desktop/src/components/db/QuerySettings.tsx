import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../ui/icon";
import { useDismissOnOutside } from "../../hooks/useDismissOnOutside";
import { patchTab, type SqlTab } from "../../lib/dbStore";

/**
 * 查询设置：每次取多少行、超时多少秒。
 *
 * 这两个值启动时不会改，却一直占着结果区底栏的两个输入框。收进齿轮后底栏只剩
 * 「已取 N 行 / 加载下 N 行」，需要调的时候再点开。
 */
export function QuerySettings({ tab }: { tab: SqlTab }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const open = pos !== null;
  // 点齿轮本身关浮层时，pointerdown 先关、紧接着的 click 又会打开：记下关的时刻
  const closedAt = useRef(0);
  useDismissOnOutside(open, boxRef, () => {
    closedAt.current = Date.now();
    setPos(null);
  });

  // 打开时把焦点送进第一个输入框：弹层挂在 body 上，不主动给焦点的话
  // 键盘用户还停在齿轮上，Tab 会跑到页面其它地方去。
  useEffect(() => {
    if (!open) return;
    const t = requestAnimationFrame(() => boxRef.current?.querySelector<HTMLInputElement>("input")?.focus());
    return () => cancelAnimationFrame(t);
  }, [open]);

  // 表格头会随结果区滚动、窗口也会变宽窄：浮层贴着齿轮算过一次位置不够，
  // 不跟着挪就会飘到别处。只在打开期间挂监听。
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setPos({ left: Math.max(8, r.right - 220), top: r.bottom + 4 });
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // 弹层里只有两个输入框，Tab 在首尾回环，别把焦点漏到背后的表格里。
  const trapTab = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const nodes = [...(boxRef.current?.querySelectorAll<HTMLElement>("input, button, select, textarea") ?? [])].filter(
      (el) => !el.hasAttribute("disabled"),
    );
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="dbx-ibtn"
        data-on={pos ? "" : undefined}
        title={`查询设置：每次取 ${tab.maxRows} 行 · 超时 ${tab.timeoutSec} 秒`}
        aria-label="查询设置"
        aria-expanded={open}
        onClick={() => {
          if (Date.now() - closedAt.current < 300) return;
          const r = btnRef.current!.getBoundingClientRect();
          setPos(pos ? null : { left: Math.max(8, r.right - 220), top: r.bottom + 4 });
        }}
      >
        <Icon name="settings" size={14} />
      </button>
      {pos &&
        createPortal(
          <div
            ref={boxRef}
            className="dbx-dd dbx-qset"
            style={pos}
            role="dialog"
            aria-modal="true"
            aria-label="查询设置"
            onKeyDown={trapTab}
          >
            <label>
              每次取
              <input
                type="number"
                min={1}
                max={10000}
                value={tab.maxRows}
                onChange={(e) => patchTab<SqlTab>(tab.id, { maxRows: Math.max(1, Math.min(10000, Number(e.target.value) || 500)) })}
              />
              行
            </label>
            <label>
              超时
              <input
                type="number"
                min={1}
                max={3600}
                value={tab.timeoutSec}
                onChange={(e) => patchTab<SqlTab>(tab.id, { timeoutSec: Math.max(1, Math.min(3600, Number(e.target.value) || 30)) })}
              />
              秒
            </label>
          </div>,
          document.body,
        )}
    </>
  );
}
