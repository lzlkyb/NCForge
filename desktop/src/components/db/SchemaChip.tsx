import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { dbApi } from "../../lib/dbApi";
import { changeSchema, useConnOf, useConnRt } from "../../lib/dbStore";
import { friendlyDbError } from "../../lib/db";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";

/**
 * 默认 schema 胶囊：显示这条连接**当前实际生效**的 schema，点开可以切。
 *
 * 切过去之后写 SQL 不用再带 `aier633.` 前缀——背后是 Oracle 的
 * `alter session set current_schema`，只影响不带前缀的名字解析，**不改变权限**：
 * 查别人 schema 的表仍然要那边给了 SELECT。
 *
 * 为什么显示 `rt.currentSchema` 而不是连接配置里的 `defaultSchema`：配置是初始值，
 * 用户可能已经手动切过；显示配置值会变成一个和真实会话不符的假名字。
 */
interface ChipState {
  open: boolean;
  q: string;
  busy: boolean;
  highlighted: string | null;
  /** null = 还没问过清单；schemas=[] 表示问过但为空；error = 读取失败。 */
  list: { schemas: string[]; error: string | null } | null;
  revision: number;
}
const INITIAL: ChipState = {
  open: false, q: "", busy: false, highlighted: null, list: null, revision: 0,
};

export function SchemaChip({ connId }: { connId: string | null }) {
  const conn = useConnOf(connId);
  const rt = useConnRt(connId);
  // 下拉交互 + 清单请求合成一份状态：这些字段总是一起变（开/关、筛选、高亮、
  // 读取中、重试）。拆成 7 个 useState 只会给「新 effect 撞旧生命周期」留机会。
  const [ui, setUi] = useState<ChipState>(INITIAL);
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const asked = useRef(false);
  const restoreFocus = useRef(false);
  const epoch = useRef(0);
  const connected = rt.status === "connected";
  const current = rt.currentSchema || rt.info?.schema || "";
  const warning = rt.info?.schemaWarning;

  // 换连接时把「已经问过清单」的标记清掉：同一个位置可能换成另一条连接
  useEffect(() => {
    const generation = epoch.current;
    asked.current = false;
    setUi(v => ({ ...v, open: false, q: "", busy: false, highlighted: null, list: null }));
    restoreFocus.current = false;
    return () => { epoch.current = generation + 1; };
  }, [connId]);

  useEffect(() => {
    if (!ui.open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setUi(v => ({ ...v, open: false }));
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && box.current?.contains(document.activeElement)) {
        e.preventDefault(); e.stopPropagation(); setUi(v => ({ ...v, open: false }));
        box.current.querySelector<HTMLButtonElement>(".dbx-schema-chip")?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ui.open]);

  // 清单正常由 loadMeta 带回来（连上就拉过一次）；这里只兜「那一次没返回」的情况。
  // 连上之后就不再重复问，避免每次点开都发一条 all_users。
  useEffect(() => {
    if (!ui.open || !connId || !connected || rt.schemas?.length || asked.current) return;
    asked.current = true;
    setUi(v => v.list ? { ...v, list: null } : v);
    const generation = epoch.current;
    void dbApi
      .schemas(connId)
      .then((r) => {
        if (generation === epoch.current) setUi(v => ({ ...v, list: { schemas: r.schemas, error: null } }));
      })
      .catch((error) => {
        if (generation === epoch.current) setUi(v => ({ ...v, list: { schemas: [], error: friendlyDbError(error) } }));
      });
  }, [ui.open, connId, connected, rt.schemas, ui.revision]);

  const all = useMemo(
    () => (rt.schemas?.length ? rt.schemas : ui.list?.schemas ?? []),
    [rt.schemas, ui.list],
  );
  const list = useMemo(() => {
    const k = ui.q.trim().toUpperCase();
    if (!k) return all;
    return all.filter((s) => s.toUpperCase().includes(k));
  }, [all, ui.q]);
  const candidate = list.includes(ui.highlighted ?? "") ? ui.highlighted! : list.includes(current) ? current : list[0];

  if (!conn) return null;

  const pick = async (name: string) => {
    if (!connId || ui.busy) return;
    const generation = epoch.current;
    setUi(v => ({ ...v, busy: true }));
    try {
      const applied = await changeSchema(connId, name);
      if (generation !== epoch.current) return;
      toast(name ? `默认 schema 已切到 ${applied}` : `已切回登录账号 ${applied}`, "success");
      restoreFocus.current = true;
      setUi(v => ({ ...v, open: false, q: "" }));
    } catch (e) {
      if (generation !== epoch.current) return;
      toast(`切换 schema 失败：${friendlyDbError(e)}`, "error");
    } finally {
      if (generation === epoch.current) setUi(v => ({ ...v, busy: false }));
    }
  };

  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || ui.busy) return;
    if (e.key === "Enter" && candidate) { e.preventDefault(); void pick(candidate); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || !list.length) return;
    e.preventDefault();
    const index = e.key === "Home" ? 0 : e.key === "End" ? list.length - 1
      : Math.max(0, Math.min(list.length - 1, list.indexOf(candidate) + (e.key === "ArrowDown" ? 1 : -1)));
    setUi(v => ({ ...v, highlighted: list[index] }));
    box.current?.querySelectorAll<HTMLElement>('[role="option"]')[index]?.scrollIntoView?.({ block: "nearest" });
  };

  return (
    <div className="dbx-schema" ref={box}>
      <button
        type="button"
        className="dbx-schema-chip"
        ref={node=>{if(node && restoreFocus.current && !ui.busy && connected){restoreFocus.current=false;node.focus();}}}
        data-warn={warning ? "" : undefined}
        disabled={!connected || ui.busy}
        aria-haspopup="listbox"
        aria-expanded={ui.open}
        aria-controls={ui.open ? listId : undefined}
        title={
          warning
            ? `默认 schema 没生效：${warning}（当前用登录账号）`
            : "默认 schema：写 SQL 时可以不写这个前缀（不改变权限）"
        }
        onClick={() => { setUi(v => ({ ...v, highlighted: null, open: !v.open })); }}
      >
        <Icon name="database" size={12} />
        <span className="dbx-schema-name">{ui.busy ? "切换中…" : current || (connected ? "登录账号" : "—")}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      {ui.open && (
        <div className="dbx-schema-pop">
          <div className="dbx-schema-filter" data-focus-container>
            <Icon name="search" size={12} />
            <input
              autoFocus
              value={ui.q}
              placeholder="筛选 schema…"
              aria-label="筛选 schema"
              role="combobox" aria-expanded={ui.open} aria-controls={listId} aria-autocomplete="list"
              aria-activedescendant={ui.highlighted && candidate ? `${listId}-${list.indexOf(candidate)}` : undefined}
              onKeyDown={onFilterKey}
              onChange={(e) => { setUi(v => ({ ...v, q: e.target.value, highlighted: null })); }}
            />
            <button type="button" className="dbx-schema-clear" disabled={!ui.q} aria-label="清除 schema 筛选" onClick={()=>{setUi(v=>({...v,q:"",highlighted:null}));box.current?.querySelector<HTMLInputElement>(".dbx-schema-filter input")?.focus();}}><Icon name="close" size={12}/></button>
          </div>
          <div className="dbx-schema-list" id={listId} role="listbox" aria-label="选择默认 schema">
            {list.length === 0 ? (
              <div className="dbx-schema-empty">{ui.list?.error ? `读取 schema 失败：${ui.list.error}` : all.length ? "没有匹配的 schema" : ui.list === null ? "正在读取 schema 清单…" : "无可切换的 schema"}</div>
            ) : (
              list.map((s, i) => (
                <button
                  key={s}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={s === current}
                  id={`${listId}-${i}`}
                  data-highlighted={ui.highlighted === s || undefined}
                  disabled={ui.busy}
                  className="dbx-schema-item"
                  onClick={() => void pick(s)}
                >
                  <span>{s}</span>
                  {s === current && <Icon name="check" size={12} />}
                </button>
              ))
            )}
          </div>
          {ui.list?.error && <button type="button" className="dbx-btn" onClick={() => { asked.current = false; setUi(v => ({ ...v, revision: v.revision + 1 })); }}>重新读取 schema</button>}
          <button
            type="button"
            className="dbx-schema-reset"
            title="回到登录账号自己的 schema"
            onClick={() => void pick("")}
          >
            恢复默认（{rt.info?.user || conn.user}）
          </button>
        </div>
      )}
    </div>
  );
}
