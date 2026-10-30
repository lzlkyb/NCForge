import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../ui/icon";
import { EnvDot } from "./EnvChips";
import { useDismissOnOutside } from "../../hooks/useDismissOnOutside";
import { dbNameOf, ENV_LABEL } from "../../lib/dbApi";
import { connOf, openConnDialog, rtOf, useDb } from "../../lib/dbStore";

/** 工具条上的连接胶囊：点开切换这个标签用的连接。 */
export function ConnPicker({ connId, onPick }: { connId: string | null; onPick: (id: string) => void }) {
  const db = useDb();
  const btnRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // 点胶囊本身关下拉时，pointerdown 先关、紧接着的 click 又会打开：记下关的时刻，click 里跳过
  const closedAt = useRef(0);
  useDismissOnOutside(pos !== null, boxRef, () => {
    closedAt.current = Date.now();
    setPos(null);
  });
  const c = connOf(connId);
  const rt = rtOf(connId);
  const on = db.conns.filter((x) => rtOf(x.id).status === "connected");
  const off = db.conns.filter((x) => rtOf(x.id).status !== "connected");

  const item = (x: (typeof db.conns)[number]) => (
    <button
      key={x.id}
      type="button"
      className={`li e-${x.env}`}
      data-sel={x.id === connId || undefined}
      onClick={() => {
        setPos(null);
        onPick(x.id);
      }}
    >
      <EnvDot env={x.env} />
      <b>{x.name}</b>
      <span className="u">
        {x.user}@{dbNameOf(x.url)}
      </span>
      <span className="r">
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
        title={c ? `${c.user}@${c.url}` : "选择连接"}
        onClick={() => {
          if (Date.now() - closedAt.current < 300) return;
          const r = btnRef.current!.getBoundingClientRect();
          setPos(pos ? null : { left: r.left, top: r.bottom + 4 });
        }}
      >
        {c ? (
          <>
            <EnvDot env={c.env} />
            <b>{c.name}</b>
            <span className="u">{c.user}</span>
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
          <div ref={boxRef} className="dbx-dd" style={pos} role="listbox">
            {on.length > 0 && <div className="sec">已连接</div>}
            {on.map(item)}
            {off.length > 0 && <div className="sec">{on.length > 0 ? "其它连接" : "连接"}</div>}
            {off.map(item)}
            <hr />
            <button
              type="button"
              className="li"
              onClick={() => {
                setPos(null);
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
