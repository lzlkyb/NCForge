// 调试面板的变量区。
//
// 变量是懒展开的：暂停那一刻只取各作用域的第一层（`lib/debugSession` 负责），
// 点开一个对象才去要它的 children。NC 的 VO 动辄几十个字段、再套 Collection，
// 一次全取会把暂停那一拍拖成好几秒。
//
// 集合类父节点带 `indexedVariables` 总数，取满一页后给「加载更多」；
// 暂停时也可以改写变量的值（只改 JVM 现场，不改源码）。
// 展开对象的字段行还给一个「眼睛」：给这个字段装观察点（watchpoint）。
// 🔴 只开在 depth ≥ 1 的行：java-debug 的 dataBreakpointInfo 要求引用能解析到
// ObjectReference，局部变量（StackFrameReference）会直接被适配器拒绝。
import { useState } from "react";
import { Icon } from "../ui/icon";
import { errorToast } from "../../lib/errorToast";
import { toast } from "../ui/toast";
import { expandVariables, setVariableValue, watchField } from "../../lib/debugSession";
import type { DapScope, DapVariable } from "../../lib/debug";

const MAX_DEPTH = 6;

function VarRow({
  v,
  variables,
  depth,
  parentRef,
}: {
  v: DapVariable;
  variables: Record<number, DapVariable[]>;
  depth: number;
  /** 这个变量挂在哪个引用下：修改变量值时 DAP 要的是「父引用 + 变量名」。 */
  parentRef: number;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const canExpand = v.variablesReference > 0 && depth < MAX_DEPTH;
  const children = variables[v.variablesReference];
  const total = v.indexedVariables ?? 0;
  const loaded = children?.length ?? 0;
  const more = total > loaded;

  const toggle = () => {
    if (!canExpand) return;
    if (!open && !children) void expandVariables(v.variablesReference);
    setOpen((o) => !o);
  };

  const beginEdit = () => {
    setDraft(v.value);
    setEditing(true);
  };
  const save = () => {
    const value = draft.trim();
    setEditing(false);
    if (!value || value === v.value) return;
    void setVariableValue(parentRef, v.name, value).catch((e) =>
      errorToast(`修改变量 ${v.name}`, e),
    );
  };

  // 字段行（depth ≥ 1）才能装观察点：父引用此时是对象引用，局部变量不是
  const canWatch = depth >= 1 && parentRef > 0;
  const watch = () => {
    void watchField(parentRef, v.name)
      .then((r) => {
        if (r === "added") toast(`已观察字段 ${v.name}：被读写时会停下`, "success");
        else toast(`字段 ${v.name} 已在观察列表中`, "success");
      })
      .catch((e) => errorToast(`观察字段 ${v.name}`, e));
  };

  return (
    <>
      <div className="dbg-var-row">
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
        <button type="button" className="dbg-icon-btn dbg-var-edit" title="改写这个变量的值" onClick={beginEdit}>
          <Icon name="edit" size={10} />
        </button>
        {canWatch && (
          <button
            type="button"
            className="dbg-icon-btn dbg-var-watch"
            title={`观察字段 ${v.name} 的读写：被访问或改写时停下`}
            onClick={watch}
          >
            <Icon name="eye" size={10} />
          </button>
        )}
      </div>
      {editing && (
        <div className="dbg-var-edit-row" style={{ paddingLeft: 26 + depth * 14 }}>
          <span className="dbg-var-name">{v.name} =</span>
          <input
            autoFocus
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
              if (e.key === "Enter") save();
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={event => { if (!event.currentTarget.closest('[data-relocating="true"]')) save(); }}
          />
        </div>
      )}
      {open && (
        <>
          {!children && <div className="dbg-empty" style={{ paddingLeft: 26 + depth * 14 }}>读取中…</div>}
          {(children ?? []).map((k) => (
            <VarRow
              key={`${k.name}#${k.variablesReference}`}
              v={k}
              variables={variables}
              depth={depth + 1}
              parentRef={v.variablesReference}
            />
          ))}
          {more && (
            <button
              type="button"
              className="dbg-var-more"
              style={{ paddingLeft: 26 + depth * 14 }}
              title="再取一页（100 条）"
              onClick={() => void expandVariables(v.variablesReference, loaded)}
            >
              加载更多（{loaded}/{total}）
            </button>
          )}
          {children && children.length === 0 && !more && (
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
              <VarRow
                key={`${v.name}#${v.variablesReference}`}
                v={v}
                variables={variables}
                depth={0}
                parentRef={s.variablesReference}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}
