import { useEffect, useRef, useState, type ReactNode } from "react";
import "../../palette.css";
import { Icon } from "../ui/icon";
import { getKeymap, paletteKeyLabel, PALETTE_MODES, type PaletteMode } from "../../lib/keymap";
import { navigate } from "../../lib/lang";
import { requestOpenFile } from "../../lib/openFileRequest";
import { closePalette, openPalette, usePalette } from "../../lib/paletteStore";
import type { Runner } from "../../lib/paletteSources";
import { usePaletteSearch } from "../../hooks/usePaletteSearch";
import type { Range } from "../../lib/fuzzy";
import { useWorkspaceSelector } from "../../lib/workspaceSession";

const PLACEHOLDER: Record<PaletteMode, string> = {
  file: "输入文件名…（# 搜内容，:行号 跳转）",
  type: "输入类名…",
  symbol: "输入方法 / 字段名…",
  sym: "输入方法 / 字段名…（整个工作区，含依赖 jar）",
  cmd: "输入命令…",
};

/**
 * 切模式时 `>` / `@` 前缀后的内容。openPalette 会改 nonce 让 PaletteBody 重挂载、查询归零，
 * 输入法一次性上屏「>停止服务」就只剩空面板；这里先把内容种下，重挂载时作为初始查询。
 * 由 PaletteBody 挂载后清空，避免污染下一次从快捷键打开的面板。
 */
let paletteSeed = "";
const seedQuery = (v: string) => { paletteSeed = v; };

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
  const [query, setQuery] = useState(() => paletteSeed);
  const restore = useRef<{ el: Element | null; on: boolean }>({ el: document.activeElement, on: true });
  const dialogRef = useRef<HTMLDivElement>(null);
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
      navigate({ kind: "jdt", uri, line, column });
      goFiles();
    },
  };
  const { result, sel, setSel, loadState, retry, listRef } = usePaletteSearch({
    mode,
    query,
    ctx: { root: root ?? null, activePath, openPaths: tabs.map((t) => t.path), run: runner },
  });
  // 本次挂载消费完 seed 后清空，避免下次正常打开面板还带着上一次的前缀内容。
  useEffect(() => { paletteSeed = ""; }, []);

  // 打开前的焦点（通常是编辑器）：Esc 关掉后要还给它；执行了某一项则不还，由目标（编辑器）自己拿焦点
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
    // 输入框里第一个字符敲 > / @ 直接切模式（和 VS Code 一样）；前缀后的内容要带过去，
    // 否则输入法一次性上屏「>停止服务」切到命令模式后查询被清空、面板空白。
    if (mode !== "cmd" && v.startsWith(">")) { seedQuery(v.slice(1)); return openPalette("cmd"); }
    if (mode !== "symbol" && v.startsWith("@")) { seedQuery(v.slice(1)); return openPalette("symbol"); }
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
