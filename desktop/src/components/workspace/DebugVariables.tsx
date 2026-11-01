// 调试面板的变量区。
//
// 变量是懒展开的：暂停那一刻只取各作用域的第一层（`lib/debugSession` 负责），
// 点开一个对象才去要它的 children。NC 的 VO 动辄几十个字段、再套 Collection，
// 一次全取会把暂停那一拍拖成好几秒。
import { useState } from "react";
import { Icon } from "../ui/icon";
import { expandVariables } from "../../lib/debugSession";
import type { DapScope, DapVariable } from "../../lib/debug";

const MAX_DEPTH = 6;

function VarRow({
  v,
  variables,
  depth,
}: {
  v: DapVariable;
  variables: Record<number, DapVariable[]>;
  depth: number;
}) {
  const [open, setOpen] = useState(false);
  const canExpand = v.variablesReference > 0 && depth < MAX_DEPTH;
  const children = variables[v.variablesReference];

  const toggle = () => {
    if (!canExpand) return;
    if (!open && !children) void expandVariables(v.variablesReference);
    setOpen((o) => !o);
  };

  return (
    <>
      <button
        type="button"
        className="dbg-var"
        style={{ paddingLeft: 8 + depth * 14 }}
        aria-expanded={canExpand ? open : undefined}
        title={canExpand ? (open ? "收起" : "展开") : `${v.type ?? ""} ${v.name}`.trim()}
        onClick={toggle}
      >
        <span className="dbg-var-chev">
          {canExpand ? <Icon name={open ? "chevronDown" : "chevronRight"} size={12} /> : null}
        </span>
        <span className="dbg-var-name">{v.name}</span>
        <span className="dbg-var-eq">=</span>
        <span className="dbg-var-val">{v.value}</span>
        {v.type && <span className="dbg-var-type">{v.type}</span>}
      </button>
      {open && (
        <>
          {!children && <div className="dbg-empty" style={{ paddingLeft: 26 + depth * 14 }}>读取中…</div>}
          {(children ?? []).map((k) => (
            <VarRow
              key={`${k.name}#${k.variablesReference}`}
              v={k}
              variables={variables}
              depth={depth + 1}
            />
          ))}
          {children && children.length === 0 && (
            <div className="dbg-empty" style={{ paddingLeft: 26 + depth * 14 }}>（没有字段）</div>
          )}
        </>
      )}
    </>
  );
}

export function DebugVariables({
  paused,
  scopes,
  variables,
}: {
  paused: boolean;
  scopes: DapScope[];
  variables: Record<number, DapVariable[]>;
}) {
  if (!paused) return <div className="dbg-empty">暂停后显示当前帧的变量。</div>;
  if (scopes.length === 0) return <div className="dbg-empty">读取变量…</div>;
  return (
    <>
      {scopes.map((s) => {
        const list = variables[s.variablesReference] ?? [];
        return (
          <div key={s.variablesReference}>
            <div className="dbg-scope">{s.name}</div>
            {list.length === 0 && <div className="dbg-empty">（没有变量）</div>}
            {list.map((v) => (
              <VarRow key={`${v.name}#${v.variablesReference}`} v={v} variables={variables} depth={0} />
            ))}
          </div>
        );
      })}
    </>
  );
}
