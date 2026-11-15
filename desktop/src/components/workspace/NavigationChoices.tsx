import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigationState, closeNavigation, navigationShouldRestoreFocus, openNavigation, chooseNavigationTarget, navigationPreview } from "../../lib/navigationService";
import { filterNavigationTargets, type NavigationTarget } from "../../lib/navigationTargets";
import { Icon } from "../ui/icon";
import "../../navigation.css";

export function NavigationChoices() {
  const state = useNavigationState();
  const [filter, setFilter] = useState({ query: "", scope: "all", module: "all", selected: 0 });
  const [preview, setPreview] = useState<{ target: NavigationTarget; text: string; note: string } | null>(null);
  const input = useRef<HTMLInputElement>(null), initialFocus = useRef<HTMLElement | null>(null), sequence = useRef(0);
  const items = filterNavigationTargets(state.items, filter.query, filter.scope, filter.module);
  const selected = items[Math.min(filter.selected, Math.max(0, items.length - 1))];
  useEffect(() => {
    if (!state.open) return;
    initialFocus.current = document.activeElement as HTMLElement;
    setFilter({ query: "", scope: "all", module: "all", selected: 0 }); setPreview(null); input.current?.focus();
    const close = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); closeNavigation(); } };
    document.addEventListener("keydown", close, true);
    return () => { document.removeEventListener("keydown", close, true); if (navigationShouldRestoreFocus() && initialFocus.current?.isConnected) initialFocus.current.focus(); };
  }, [state.open, state.intent]);
  useEffect(() => { ++sequence.current; setPreview(null); }, [selected, state.open]);
  const showPreview = async () => {
    if (!selected) return;
    const request = ++sequence.current;
    try { const value = await navigationPreview(selected); if (request === sequence.current) setPreview({ target: selected, ...value }); }
    catch (error) { if (request === sequence.current) setPreview({ target: selected, text: String(error), note: "读取失败，可重试或打开目标" }); }
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setFilter(value => ({ ...value, selected: (value.selected + (event.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length) })); }
    if (event.key === "Enter" && selected) { event.preventDefault(); void chooseNavigationTarget(selected, event.ctrlKey); }
  };
  if (!state.open) return null;
  return createPortal(<section className="nav-choices ui-surface" role="dialog" aria-label={state.title} onKeyDown={onKey}>
    <header><strong>{state.title}</strong><span>{state.items.length} 个目标</span><button type="button" className="wb-icon-btn" aria-label="关闭导航选择" onClick={closeNavigation}><Icon name="close" size={14} /></button></header>
    <div className="nav-filter"><input ref={input} aria-label="筛选导航目标" placeholder="输入类名、方法、模块或 JAR 路径…" value={filter.query} onChange={event => setFilter(value => ({ ...value, query: event.target.value, selected: 0 }))} />
      <select aria-label="导航来源" value={filter.scope} onChange={event => setFilter(value => ({ ...value, scope: event.target.value, selected: 0 }))}><option value="all">全部来源</option><option value="source">源码</option><option value="library">依赖库</option><option value="assembly">NC 注册</option></select>
      <select aria-label="导航模块" value={filter.module} onChange={event => setFilter(value => ({ ...value, module: event.target.value, selected: 0 }))}><option value="all">全部模块</option>{[...new Set(state.items.map(target => target.module).filter(Boolean))].map(module => <option key={module} value={module}>{module}</option>)}</select>
    </div>
    {state.loading ? <div className="nav-message" role="status">正在查询目标…</div> : state.error ? <div className="nav-message" role="alert">{state.error}<button type="button" className="wb-status-btn" onClick={() => void openNavigation(state.kind, state.intent, true)}>重试</button></div> : <div className="nav-targets" role="listbox" aria-label="导航目标">{items.map((target, index) => <button type="button" role="option" aria-selected={selected === target} key={`${target.uri}:${target.range.start.line}:${index}`} onFocus={() => setFilter(value => ({ ...value, selected: index }))} onClick={() => void chooseNavigationTarget(target)}>
      <strong>{target.label}</strong><small title={target.source}>{target.module && `${target.module} · `}{target.source} · {target.range.start.line + 1}</small>
    </button>)}{!items.length && <div className="nav-message">没有符合筛选条件的目标。</div>}</div>}
    {state.note && <p className="nav-message">{state.note}</p>}
    <footer><button type="button" className="wb-status-btn" disabled={!selected} onClick={() => void showPreview()}>就地预览</button><button type="button" className="wb-status-btn" disabled={!selected} onClick={() => void chooseNavigationTarget(selected, true)}>在右侧打开</button><span>Enter 打开 · Ctrl+Enter 右侧 · Esc 关闭</span></footer>
    {preview && <div className="nav-preview"><small>{preview.note}</small><pre>{preview.text.split(/\r?\n/).slice(/反编译|签名/.test(preview.note) ? 0 : Math.max(0, preview.target.range.start.line - 5), /反编译|签名/.test(preview.note) ? 20 : preview.target.range.start.line + 15).join("\n")}</pre></div>}
  </section>, document.body);
}
