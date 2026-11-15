import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal } from "../ui/Modal";
import { closeRefactorMenu, refactorMenuItems, useRefactorMenu } from "../../lib/refactorMenu";
import { toast } from "../ui/toast";

const GROUP_ORDER = ["提取", "内联", "移动与重命名", "批量与搜索"] as const;

/**
 * 「重构」选择器：一个列表，上下选，回车执行。
 *
 * 不折叠成下拉菜单是因为每一项都要带上「先选中什么」的说明——用户不是记不住功能名，
 * 是不知道自己该选哪个。
 *
 * 键盘接在 document 上而不是容器上：Modal 的焦点陷阱可能把焦点放在关闭按钮，
 * 那时容器收不到 keydown，↑↓ 会漏到编辑器里移动光标。
 */
export function RefactorMenuHost() {
  const { open } = useRefactorMenu();
  const items = useMemo(() => (open ? refactorMenuItems() : []), [open]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (open) setActive(0);
  }, [open]);

  const run = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return;
      closeRefactorMenu();
      try {
        void item.run();
      } catch (e) {
        toast(`${item.label}失败：${String(e)}`, "error");
      }
    },
    [items],
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRefactorMenu();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i + delta + items.length) % items.length);
      } else if (event.key === "Enter") {
        event.preventDefault();
        run(active);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, items, active, run]);

  if (!open) return null;

  return (
    <Modal
      open
      ariaLabel="重构"
      onClose={closeRefactorMenu}
      className="w-full max-w-lg rounded-[var(--r-dialog)] modal-surface p-4"
    >
      <div role="listbox" aria-label="选择重构方式">
        <h3 className="mb-1 text-base font-semibold">重构</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          先选中要改的代码再打开；改动一律先出预览，确认后才写入。
        </p>
        {GROUP_ORDER.map((group) => {
          const rows = items.map((item, index) => ({ item, index })).filter(({ item }) => item.group === group);
          if (!rows.length) return null;
          return (
            <section key={group} className="mb-2">
              <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{group}</p>
              {rows.map(({ item, index }) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className={`block w-full rounded-[var(--r-control)] px-2 py-1.5 text-left ${index === active ? "bg-accent" : "hover:bg-accent"}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => run(index)}
                >
                  <span className="block text-sm">{item.label}</span>
                  <span className="block text-xs text-muted-foreground">{item.hint}</span>
                </button>
              ))}
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
