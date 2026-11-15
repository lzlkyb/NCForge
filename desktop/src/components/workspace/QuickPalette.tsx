import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import "../../palette.css";
import { Icon } from "../ui/icon";
import { getKeymap, paletteKeyLabel, PALETTE_MODES, type PaletteMode } from "../../lib/keymap";
import { requestOpenFile } from "../../lib/openFileRequest";
import { closePalette, openPalette, usePalette, getPalette } from "../../lib/paletteStore";
import type { Runner } from "../../lib/paletteSources";
import { usePaletteSearch } from "../../hooks/usePaletteSearch";
import { getSearchForm, setSearchForm, subscribeSearchForm, loadHistory, cancelWorkspaceSearch, getSearchSelectedKey } from "../../lib/searchStore";
import { runWorkspaceSearch } from "../../lib/searchRunner";
import type { Range } from "../../lib/fuzzy";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
import { useDocumentSymbols } from "../../hooks/useDocumentSymbols";
import { PaletteSymbolTools } from "./PaletteSymbolTools";
import { isUnsaved } from "../../lib/tabDirty";

const WorkspaceSearch = lazy(() => import("./PaletteWorkspaceSearch").then(m => ({ default: m.PaletteWorkspaceSearch })));

const PLACEHOLDER: Record<PaletteMode, string> = {
  file: "输入文件名…（# 工程搜索，:行号 跳转）",
  search: "输入工程内容，回车搜索…",
  type: "输入类名…",
  symbol: "输入方法 / 字段名…",
  sym: "输入方法 / 字段名…（整个工作区，含依赖 jar）",
  cmd: "输入命令…",
};

/** 把命中区间用 <mark> 圈出来。 */
function Marked({ text, ranges }: { text: string; ranges?: Range[] }) {
  if (!ranges?.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark key={i}>{text.slice(a, b)}</mark>);
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/**
 * 文件、工程搜索、类型、符号与命令共用浮层输入及焦点管理。
 *
 * 开关由 `paletteStore` 管；每次打开 / 切模式 `nonce` 都变，用它当 key 让正文重新挂载，查询和选中项自然归零。
 */
export function QuickPalette({ activeTab, onNavigate }: { activeTab: string; onNavigate: (tab: string) => void }) {
  const { open, mode, nonce, query } = usePalette();
  const restore = useRef<{ el: Element | null; on: boolean }>({ el: document.activeElement, on: true });
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) restore.current = { el: document.activeElement, on: true };
  wasOpen.current = open;
  useEffect(() => {
    if (!open) return;
    const original = restore.current;
    // 预览关闭后它的按钮已卸载，焦点可能落到 body；Esc 仍归当前浮层处理。
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-palette]):not([data-exiting])')) return;
      event.preventDefault(); closePalette();
    };
    window.addEventListener("keydown", onEscape);
    return () => { window.removeEventListener("keydown", onEscape); if (original.on && original.el instanceof HTMLElement) original.el.focus({ preventScroll: true }); };
  }, [open]);
  if (!open) return null;
  return <PaletteBody key={nonce} mode={mode} initialQuery={query} activeTab={activeTab} onNavigate={onNavigate}
    onExecute={() => { restore.current.on = false; }} />;
}

function PaletteBody({ mode, initialQuery, activeTab, onNavigate, onExecute }: { mode: PaletteMode; initialQuery: string; activeTab: string; onNavigate: (tab: string) => void; onExecute: () => void }) {
  const root = useWorkspaceSelector((s) => s.root);
  const activePath = useWorkspaceSelector((s) => s.activePath);
  const tabs = useWorkspaceSelector((s) => s.tabs);
  const [navigationQuery, setQuery] = useState(initialQuery);
  const [methodsOnly, setMethodsOnly] = useState(false);
  const active = tabs.find(tab => tab.path === activePath);
  const documentSymbols = useDocumentSymbols(mode === "symbol" ? activePath : null, active?.mtimeMs, active ? isUnsaved(active) : false);
  const form = useSyncExternalStore(subscribeSearchForm, getSearchForm, getSearchForm);
  const engineering = mode === "search";
  const query = engineering ? form.query : navigationQuery;
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (engineering) return () => cancelWorkspaceSearch(); }, [engineering]);
  // 遮罩关闭要求按下与抬起都落在遮罩上：mousedown 在弹窗内、mouseup 在遮罩（或反过来）
  // 时 click 的 target 都是公共祖先遮罩，只判 down 会反方向误关、丢掉已输入的长查询。
  const downOnScrim = useRef(false);
  const upOnScrim = useRef(false);

  const goFiles = () => {
    if (activeTab !== "files") onNavigate("files");
  };
  const runner: Runner = {
    file: (path, line, column) => {
      requestOpenFile({ path, line, column });
      goFiles();
    },
    jdt: (uri, line, column) => {
      goFiles();
      void import("../../lib/lang").then(({ navigate }) => navigate({ kind: "jdt", uri, line, column }));
    },
  };
  const { result, sel, setSel, loadState, retry, listRef } = usePaletteSearch({
    mode,
    query,
    ctx: { root: root ?? null, activePath, openPaths: tabs.map((t) => t.path), run: runner, documentSymbols: documentSymbols.symbols, methodsOnly },
  });
  const close = () => closePalette();
  const runAt = (i: number) => {
    const item = result.items[i];
    if (!item) return;
    closePalette();
    item.run();
    if (!getPalette().open) onExecute();
  };

  const onChange = (v: string) => {
    if (engineering) { setSearchForm({ query: v }); return; }
    if (mode === "file" && v.startsWith("#")) return openPalette("search", v.slice(1));
    // 输入框里第一个字符敲 > / @ 直接切模式（和 VS Code 一样）；前缀后的内容要带过去，
    // 否则输入法一次性上屏「>停止服务」切到命令模式后查询被清空、面板空白。
    if (mode !== "cmd" && v.startsWith(">")) return openPalette("cmd", v.slice(1));
    if (mode !== "symbol" && v.startsWith("@")) return openPalette("symbol", v.slice(1));
    setQuery(v);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (engineering && e.key === "Enter") { e.preventDefault(); void runWorkspaceSearch(root ?? null); return; }
    if (engineering && e.key === "ArrowDown") {
      e.preventDefault();
      const list = dialogRef.current?.querySelector<HTMLElement>('[aria-label="搜索结果列表"]');
      list?.focus();
      if (!getSearchSelectedKey()) list?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      return;
    }
    const n = result.items.length;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" && n) {
      e.preventDefault();
      setSel((s) => (s + 1) % n);
    } else if (e.key === "ArrowUp" && n) {
      e.preventDefault();
      setSel((s) => (s - 1 + n) % n);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // 列表里可能还是上一轮的结果（输入改了、新结果没到）：这时候回车会打开
      // 一个已经不匹配的条目，比「按了没反应」更糟。
      if (loadState === "loading") return;
      runAt(sel);
    } else if (e.key === "Backspace" && query === "" && mode !== "file") {
      // 在空的命令 / 符号模式里退格，回到最常用的「文件」模式
      e.preventDefault();
      openPalette("file");
    }
  };

  /**
   * Tab 不出弹层（模态焦点陷阱）。浮层里可聚焦的本来只有输入框和模式按钮，
   * 不拦的话 Tab 会把焦点送到背后编辑器的 Monaco 里，而 Esc 之后焦点又回到那里。
   */
  const onDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
      // Nested replacement confirmation owns its own Escape/focus handling.
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-palette])')) return;
      e.preventDefault(); close(); return;
    }
    if (e.key !== "Tab") return;
    if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-palette])')) return;
    const el = dialogRef.current;
    if (!el) return;
    const focusables = [...el.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')].filter(node => !node.closest('[hidden], [aria-hidden="true"]'));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const cur = document.activeElement;
    if (e.shiftKey && (cur === first || !el.contains(cur))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (cur === last || !el.contains(cur))) {
      e.preventDefault();
      first.focus();
    }
  };

  const keymap = getKeymap();
  return (
    <div
      className="qp-scrim"
      onMouseDown={(e) => { downOnScrim.current = e.target === e.currentTarget; upOnScrim.current = false; }}
      onMouseUp={(e) => { upOnScrim.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (!downOnScrim.current || !upOnScrim.current || e.target !== e.currentTarget) return;
        downOnScrim.current = false; upOnScrim.current = false;
        close();
      }}
    >
      <div ref={dialogRef} className={engineering ? "qp qp-workspace" : "qp"} role="dialog" aria-modal="true" aria-label="快速导航" data-palette onKeyDown={onDialogKeyDown}>
        <div className="qp-in" data-focus-container>
          <Icon name="search" size={15} />
          <input
            autoFocus
            value={query}
            placeholder={PLACEHOLDER[mode]}
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            list={engineering ? "ncforge-search-history" : undefined}
            role={engineering ? "searchbox" : "combobox"}
            aria-expanded={engineering ? undefined : true}
            aria-controls={engineering ? undefined : "qp-listbox"}
            aria-autocomplete={engineering ? undefined : "list"}
            aria-activedescendant={!engineering && result.items.length > 0 ? `qp-opt-${sel}` : undefined}
            aria-label={engineering ? "搜索工程文件内容" : "快速导航输入"}
          />
          {engineering && <>
            <datalist id="ncforge-search-history">{loadHistory().map(word => <option key={word} value={word} />)}</datalist>
            <button type="button" className="qp-search-submit" disabled={!query.trim() || form.replacing} onClick={() => void runWorkspaceSearch(root ?? null)}>{form.running ? "重新搜索" : "搜索"}</button>
          </>}
        </div>
        <div className="qp-modes">
          {PALETTE_MODES.map((m) => (
            <button key={m.mode} type="button" className="qp-mode" data-on={m.mode === mode || undefined} aria-pressed={m.mode === mode} onClick={() => openPalette(m.mode)}>
              <span className="qp-mode-label">{m.label}</span>
              <kbd>{paletteKeyLabel(m.mode, keymap)}</kbd>
            </button>
          ))}
        </div>
        {mode === "symbol" && <PaletteSymbolTools path={activePath} methodsOnly={methodsOnly} onMethodsOnly={() => setMethodsOnly(value => !value)} />}
        {engineering ? <Suspense fallback={<div className="qp-sec" role="status">正在准备工程搜索…</div>}>
          <WorkspaceSearch onExecute={() => { onExecute(); closePalette(); goFiles(); }} />
        </Suspense> : <><div
          className={loadState === "error" ? "qp-sec qp-sec-err" : "qp-sec"}
          role={loadState === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {loadState === "loading" && (
            <span className="qp-busy">
              <Icon name="spinner" size={12} className="animate-spin" aria-hidden="true" />
              {result.items.length > 0 ? "更新中…" : "查询中…"}
            </span>
          )}
          {result.note && <span>{result.note}</span>}
          {loadState === "error" && (
            <button type="button" className="qp-retry" onClick={retry}>重试</button>
          )}
        </div>
        <div className="qp-list" id="qp-listbox" ref={listRef} role="listbox" aria-label="候选" aria-busy={loadState === "loading"}>
          {result.items.map((it, i) => (
            <div key={it.key} id={`qp-opt-${i}`} role="option" aria-selected={i === sel} data-sel={i === sel} className="qp-li" onMouseMove={() => i !== sel && setSel(i)} onClick={() => runAt(i)}>
              {it.kind ? <span className="qp-k" data-k={it.kind}>{it.kind}</span> : mode === "file" ? <Icon name="file" size={14} /> : null}
              <span className="qp-title"><Marked text={it.title} ranges={it.ranges} /></span>
              {it.badge && <span className="qp-badge">{it.badge}</span>}
              {it.hint ? <kbd className="qp-h">{it.hint}</kbd> : <span className="qp-h">{it.detail}</span>}
            </div>
          ))}
        </div>
        </>}
        <div className="qp-foot">
          <span>{engineering ? "↓ 进入结果 · ↑↓ 选择" : "↑↓ 选择"}</span>
          <span>{engineering ? "Enter 搜索 / 打开" : "Enter 打开"}</span>
          <span>Esc 关闭</span>
          <span className="qp-sp" />
          <span>{engineering ? "重开恢复阅读位置" : mode === "file" ? "> 命令，@ 符号，# 工程搜索，:行号" : "退格回到文件模式"}</span>
        </div>
      </div>
    </div>
  );
}
