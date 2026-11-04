import { useEffect, useRef, useState, type ReactNode } from "react";
import "../../palette.css";
import { Icon } from "../ui/icon";
import { getKeymap, paletteKeyLabel, PALETTE_MODES, type PaletteMode } from "../../lib/keymap";
import { navigate } from "../../lib/lang";
import { requestOpenFile } from "../../lib/openFileRequest";
import { closePalette, openPalette, usePalette } from "../../lib/paletteStore";
import { buildItems, type PaletteCtx, type PaletteResult, type Runner } from "../../lib/paletteSources";
import type { Range } from "../../lib/fuzzy";
import { useWorkspaceSelector } from "../../lib/workspaceSession";

const PLACEHOLDER: Record<PaletteMode, string> = {
  file: "输入文件名…（# 搜内容，:行号 跳转）",
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
 * 快速导航浮层：文件 / 类型 / 符号 / 命令四种模式共用一个输入框。
 *
 * 开关由 `paletteStore` 管；每次打开 / 切模式 `nonce` 都变，用它当 key 让正文重新挂载，查询和选中项自然归零。
 */
export function QuickPalette({ activeTab, onNavigate }: { activeTab: string; onNavigate: (tab: string) => void }) {
  const { open, mode, nonce } = usePalette();
  if (!open) return null;
  return <PaletteBody key={nonce} mode={mode} activeTab={activeTab} onNavigate={onNavigate} />;
}

function PaletteBody({ mode, activeTab, onNavigate }: { mode: PaletteMode; activeTab: string; onNavigate: (tab: string) => void }) {
  const root = useWorkspaceSelector((s) => s.root);
  const activePath = useWorkspaceSelector((s) => s.activePath);
  const tabs = useWorkspaceSelector((s) => s.tabs);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [result, setResult] = useState<PaletteResult>({ items: [], note: "" });
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [retryTick, setRetryTick] = useState(0);
  const lastKey = useRef("");
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // 打开前的焦点（通常是编辑器）：Esc 关掉后要还给它；执行了某一项则不还，由目标（编辑器）自己拿焦点
  const restore = useRef<{ el: Element | null; on: boolean }>({ el: document.activeElement, on: true });

  const goFiles = () => {
    if (activeTab !== "files") onNavigate("files");
  };
  const runner: Runner = {
    file: (path, line, column) => {
      requestOpenFile({ path, line, column });
      goFiles();
    },
    jdt: (uri, line, column) => {
      navigate({ kind: "jdt", uri, line, column });
      goFiles();
    },
  };
  const ctx: PaletteCtx = { root: root ?? null, activePath, openPaths: tabs.map((t) => t.path), run: runner };
  // 查询变化很频繁，异步查询的闭包用 ref 拿最新的 ctx，不把它列进 effect 依赖
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  useEffect(() => {
    let alive = true;
    // 查询一变就先清空：不把上一次的结果留在列表里，回车就不会打开已经不匹配的条目。
    const key = `${mode}\u0000${query}`;
    if (lastKey.current !== key) {
      lastKey.current = key;
      setResult({ items: [], note: "" });
      setSel(0);
    }
    setLoadState("loading");
    // 类型搜索要问语言服务、`#` 内容搜索要扫整个工程：输入时稍等一下再发，
    // 免得每个字符一个请求（`:行号` 是本地解析，不延迟）
    const slow = mode === "type" || (mode === "file" && query.trim().startsWith("#"));
    const t = setTimeout(() => {
      buildItems(mode, query, ctxRef.current)
        .then((r) => {
          if (!alive) return;
          setResult(r);
          setSel(0);
          setLoadState("ready");
        })
        .catch((e) => {
          // 不能吞：工程根读不到、语言服务挂了都会走到这里，静默空列表会被当成「没有这个类」
          if (!alive) return;
          setResult({ items: [], note: `查询失败：${e instanceof Error ? e.message : String(e)}` });
          setSel(0);
          setLoadState("error");
        });
    }, slow && query ? 200 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [mode, query, retryTick]);

  useEffect(() => {
    listRef.current?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel, result]);

  useEffect(() => {
    const r = restore.current;
    return () => {
      if (r.on && r.el instanceof HTMLElement) r.el.focus({ preventScroll: true });
    };
  }, []);

  const close = () => closePalette();
  const runAt = (i: number) => {
    const item = result.items[i];
    if (!item) return;
    restore.current.on = false;
    closePalette();
    item.run();
  };

  const onChange = (v: string) => {
    // 输入框里第一个字符敲 > / @ 直接切模式（和 VS Code 一样）
    if (mode !== "cmd" && v.startsWith(">")) return openPalette("cmd");
    if (mode !== "symbol" && v.startsWith("@")) return openPalette("symbol");
    setQuery(v);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
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
    if (e.key !== "Tab") return;
    const el = dialogRef.current;
    if (!el) return;
    const focusables = el.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])');
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
    <div className="qp-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={dialogRef} className="qp" role="dialog" aria-modal="true" aria-label="快速导航" data-palette onKeyDown={onDialogKeyDown}>
        <div className="qp-in" data-focus-container>
          <Icon name="search" size={15} />
          <input
            autoFocus
            value={query}
            placeholder={PLACEHOLDER[mode]}
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded
            aria-controls="qp-listbox"
            aria-autocomplete="list"
            aria-activedescendant={result.items.length > 0 ? `qp-opt-${sel}` : undefined}
            aria-label="快速导航输入"
          />
        </div>
        <div className="qp-modes">
          {PALETTE_MODES.map((m) => (
            <button key={m.mode} type="button" className="qp-mode" data-on={m.mode === mode || undefined} aria-pressed={m.mode === mode} onClick={() => openPalette(m.mode)}>
              <span className="qp-mode-label">{m.label}</span>
              <kbd>{paletteKeyLabel(m.mode, keymap)}</kbd>
            </button>
          ))}
        </div>
        <div
          className={loadState === "error" ? "qp-sec qp-sec-err" : "qp-sec"}
          role={loadState === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {loadState === "loading" && (
            <span className="qp-busy"><Icon name="spinner" size={12} className="animate-spin" aria-hidden="true" />查询中…</span>
          )}
          {result.note && <span>{result.note}</span>}
          {loadState === "error" && (
            <button type="button" className="qp-retry" onClick={() => setRetryTick((n) => n + 1)}>重试</button>
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
        <div className="qp-foot">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
          <span className="qp-sp" />
          <span>{mode === "file" ? "> 命令，@ 符号，# 内容，:行号" : "退格回到文件模式"}</span>
        </div>
      </div>
    </div>
  );
}
