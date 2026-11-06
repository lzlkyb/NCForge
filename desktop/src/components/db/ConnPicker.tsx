import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../ui/icon";
import { EnvDot } from "./EnvChips";
import { dbNameOf, ENV_LABEL } from "../../lib/dbApi";
import { connOf, openConnDialog, rtOf, useDbConns, useDbRt } from "../../lib/dbStore";

/** 工具条上的连接胶囊：点开切换这个标签用的连接。 */
export function ConnPicker({ connId, onPick, disabled = false, compact = false }: { connId: string | null; onPick: (id: string) => void; disabled?: boolean; compact?: boolean }) {
  // 列表里每个连接都按状态分组：订阅连接清单 + 运行态，不订标签（查询结果变化与它无关）
  useDbRt();
  const db = { conns: useDbConns() };
  const btnRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const listId = useId();
  const c = connOf(connId);
  const rt = rtOf(connId);
  const on = db.conns.filter((x) => rtOf(x.id).status === "connected");
  const off = db.conns.filter((x) => rtOf(x.id).status !== "connected");
  const options = [...on, ...off];
  const close = () => {
    btnRef.current?.focus({ preventScroll: true });
    setPos(null);
  };
  const open = (last = false) => {
    if (disabled) return;
    const r = btnRef.current!.getBoundingClientRect();
    setFocusId(connId ?? (last ? options[options.length - 1]?.id : options[0]?.id) ?? null);
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 388)), top: r.bottom + 4 });
  };
  const opened = pos !== null;
  useLayoutEffect(() => {
    if (!opened) return;
    const box = boxRef.current;
    const target = box?.querySelector<HTMLButtonElement>(`[role="option"][data-focus]`) ?? box?.querySelector<HTMLButtonElement>("button");
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest" });
    if (box && box.getBoundingClientRect().bottom > window.innerHeight - 8) {
      setPos((p) => p && ({ ...p, top: Math.max(8, window.innerHeight - box.offsetHeight - 8) }));
    }
  }, [opened]);
  useEffect(() => {
    if (!opened) return;
    const dismiss = (e: Event) => {
      if (boxRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      // 点到另一个控件时让它接管焦点；只在焦点仍位于即将卸载的菜单时归还。
      if (boxRef.current?.contains(document.activeElement)) btnRef.current?.focus({ preventScroll: true });
      setPos(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [opened]);
  useEffect(() => { if (disabled) setPos(null); }, [disabled]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    const items = [...(boxRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0 || !items.length) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); items[i].click(); return; }
    const n = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? (i + 1) % items.length : e.key === "ArrowUp" ? (i - 1 + items.length) % items.length : -1;
    if (n < 0) return;
    e.preventDefault();
    items[n].focus({ preventScroll: true });
    items[n].scrollIntoView?.({ block: "nearest" });
  };

  const item = (x: (typeof db.conns)[number]) => (
    <button
      key={x.id}
      type="button"
      role="option"
      aria-selected={x.id === connId}
      tabIndex={focusId === x.id ? 0 : -1}
      data-focus={focusId === x.id || undefined}
      className={`li e-${x.env}`}
      data-sel={x.id === connId || undefined}
      onClick={() => {
        if (disabled) return;
        close();
        onPick(x.id);
      }}
      onFocus={() => setFocusId(x.id)}
    >
      <EnvDot env={x.env} />
      <b>{x.name}</b>
      <span className="u">
        {x.user}@{dbNameOf(x.url)}
      </span>
      <span className="r">
        {x.engine === "rust" && <span className="dbx-echip" title="纯 Rust 驱动：省内存（不常驻 JVM）">Rust</span>}
        <span className="dbx-echip">{ENV_LABEL[x.env]}</span>
      </span>
    </button>
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`dbx-connpick${c ? ` e-${c.env}` : ""}`}
        disabled={disabled}
        aria-label={`选择连接：${c?.name ?? "未选连接"}`}
        aria-expanded={opened}
        aria-haspopup="listbox"
        aria-controls={opened ? listId : undefined}
        title={c ? `${c.user}@${c.url}${c.engine === "rust" ? "（纯 Rust 驱动）" : ""}` : "选择连接"}
        onClick={() => {
          if (opened) close(); else open();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(e.key === "ArrowUp"); }
        }}
      >
        {c ? (
          <>
            {!compact && <EnvDot env={c.env} />}
            <b>{c.name}</b>
            {!compact && <span className="u">{dbNameOf(c.url)}</span>}
            {rt.status === "connecting" && <Icon name="spinner" size={11} />}
            {rt.status === "error" && <Icon name="alert" size={11} />}
          </>
        ) : (
          <span className="u">未选连接</span>
        )}
        <Icon name="chevronDown" size={12} />
      </button>
      {pos &&
        createPortal(
          <div ref={boxRef} className="dbx-dd" style={pos} onKeyDown={onKey} onBlur={(e) => {
            if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setPos(null);
          }}>
            <div id={listId} role="listbox" aria-label="数据库连接">
              {on.length > 0 && <div role="group" aria-label="已连接"><div className="sec" aria-hidden="true">已连接</div>{on.map(item)}</div>}
              {off.length > 0 && <div role="group" aria-label={on.length > 0 ? "其它连接" : "连接"}><div className="sec" aria-hidden="true">{on.length > 0 ? "其它连接" : "连接"}</div>{off.map(item)}</div>}
            </div>
            <hr />
            <button
              type="button"
              className="li"
              onClick={() => {
                close();
                openConnDialog(null);
              }}
            >
              <Icon name="plus" size={13} />
              新建连接…
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
