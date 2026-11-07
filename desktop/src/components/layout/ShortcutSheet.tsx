import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { registerCommands } from "../../lib/commandRegistry";
import { bindingRows, getKeymap, type BindingRow } from "../../lib/keymap";
import { PAGES } from "../../lib/pages";
import { requestSettingsSection } from "../../lib/settingsJump";
import { matchText } from "../../lib/pinyin";

/**
 * 一览里的行：group 放宽为 string，好让「页面切换」组不依赖 lib/keymap.ts 的
 * BindingGroup 联合（那文件由别的子代理独占，不改它）。
 */
type SheetRow = Omit<BindingRow, "group"> & { group: string };

/** 不在 bindingRows 里、但确实固定的键（见 KeymapSettings 的说明）。 */
const FIXED: SheetRow[] = [
  { id: "fixed.save", label: "保存当前文件", group: "固定键", keys: ["ctrl+s"], display: ["Ctrl+S"], overridden: false },
  { id: "fixed.callHierarchy", label: "调用层级", group: "固定键", keys: ["ctrl+alt+h"], display: ["Ctrl+Alt+H"], overridden: false },
  { id: "fixed.thisSheet", label: "打开 / 关闭快捷键一览", group: "固定键", keys: ["?"], display: ["?"], overridden: false },
];

/** 页面切换组：由 PAGES 派生（含 hotkey），? 搜「代码」「Ctrl+3」都能命中（P1-16）。 */
const PAGE_ROWS: SheetRow[] = PAGES.filter((p) => p.hotkey != null).map((p) => ({
  id: `page.${p.key}`,
  label: `转到：${p.label}`,
  group: "页面切换",
  keys: [`ctrl+${p.hotkey}`],
  display: [`Ctrl+${p.hotkey}`],
  overridden: false,
}));

const GROUP_ORDER = ["快速导航", "窗口", "搜索与层级", "编辑器", "页面切换", "固定键"] as const;

function groupRows(rows: SheetRow[]): { label: string; rows: SheetRow[] }[] {
  return GROUP_ORDER.map((label) => ({ label, rows: rows.filter((r) => r.group === label) })).filter(
    (g) => g.rows.length > 0,
  );
}

const KBD = "rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground";

/** 同一个组合键被多个动作占用时，这些动作的冲突键（展示串）。 */
function conflictKeys(rows: SheetRow[]): Map<string, string[]> {
  const owners = new Map<string, number>();
  for (const row of rows) for (const key of row.keys) owners.set(key, (owners.get(key) ?? 0) + 1);
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const dup = row.keys.filter((k) => (owners.get(k) ?? 0) > 1);
    if (dup.length) out.set(row.id, dup.map((k) => row.display[row.keys.indexOf(k)] ?? k));
  }
  return out;
}

/**
 * `?` 打开的快捷键一览。只在外壳（非输入框、非编辑器、无模态框）响应——
 * Java 的三元 `?` 必须优先留在编辑器里。
 */
export function ShortcutSheet() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(
    () =>
      registerCommands([
        { id: "help.shortcuts", title: "查看快捷键一览", hint: "?", run: () => setOpen(true) },
      ]),
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.ctrlKey || e.altKey || e.metaKey || e.isComposing || e.repeat) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (
        target &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
          !!target.closest(".monaco-editor"))
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"][aria-modal="true"], dialog[open], [data-palette]')) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const keymap = getKeymap();
  const all: SheetRow[] = [...bindingRows(keymap), ...FIXED, ...PAGE_ROWS];
  const conflicts = conflictKeys(all);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // 中英文都可搜：动作名（含拼音首字母）与按键串都参与匹配
  const matched = terms.length
    ? all.filter((row) =>
        terms.every(
          (term) =>
            row.label.toLowerCase().includes(term) ||
            row.display.some((d) => d.toLowerCase().includes(term)) ||
            !!matchText(term, row.label),
        ),
      )
    : all;
  const groups = groupRows(matched);
  /** 点「修改」：记下要改的键位 → 关一览 → 切到设置（快捷键分类会直接进入采集态）。 */
  const edit = (id: string) => {
    requestSettingsSection("快捷键", id);
    setOpen(false);
    window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "settings" }));
  };
  return (
    <Modal open={open} onClose={() => setOpen(false)} ariaLabel="快捷键一览" className="modal-surface">
      <div className="flex max-h-[70vh] w-[min(720px,92vw)] flex-col gap-4 overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-medium">快捷键一览</h2>
            <span className="text-xs text-muted-foreground">
              当前方案：{keymap === "eclipse" ? "Eclipse" : "IntelliJ IDEA"} · 点「修改」可直接改键
            </span>
          </div>
          {/* 弹窗里必须有一个可聚焦控件：否则 Esc 监听挂在内容节点上收不到键，焦点也无处可还。 */}
          <button
            type="button"
            aria-label="关闭"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            onClick={() => setOpen(false)}
          >
            <Icon name="close" size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2 text-muted-foreground focus-within:border-ring">
          <Icon name="search" size={14} aria-hidden="true" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索动作或按键…"
            aria-label="搜索快捷键"
            spellCheck={false}
            className="h-8 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
          />
          {query && (
            <button
              type="button"
              aria-label="清除搜索"
              className="grid h-5 w-5 place-items-center rounded hover:bg-accent"
              onClick={() => setQuery("")}
            >
              <Icon name="close" size={13} aria-hidden="true" />
            </button>
          )}
        </div>
        {terms.length > 0 && (
          <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
            {matched.length ? `匹配 ${matched.length} 项` : "没有匹配的快捷键"}
          </p>
        )}
        {matched.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
            <Icon name="search" size={24} aria-hidden="true" />
            <p>没有找到与「{query.trim()}」相关的快捷键</p>
            <button type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={() => setQuery("")}>
              清除搜索
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            {groups.map((group) => (
              <section key={group.label} className="flex flex-col gap-1">
                <h3 className="text-xs font-semibold text-muted-foreground">{group.label}</h3>
                {group.rows.map((row) => {
                  const dup = conflicts.get(row.id);
                  // 固定键与页面切换键都是系统保留映射，不提供「修改」入口。
                  const editable = !row.id.startsWith("fixed.") && !row.id.startsWith("page.");
                  return (
                    <div
                      key={row.id}
                      className="flex items-center justify-between gap-3 border-b border-border/60 py-1 text-sm last:border-0"
                    >
                      <span className="min-w-0 truncate">
                        {row.label}
                        {dup && (
                          <span
                            className="ml-1.5 rounded bg-destructive/10 px-1.5 text-[11px] font-semibold text-destructive-ink"
                            title={`同一个组合键还用于其它动作：${dup.join("、")}`}
                          >
                            冲突
                          </span>
                        )}
                      </span>
                      <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                        {row.display.length ? (
                          row.display.map((key) => (
                            <kbd key={key} className={KBD}>
                              {key}
                            </kbd>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground">未绑定</span>
                        )}
                        {editable && (
                          <button
                            type="button"
                            className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                            onClick={() => edit(row.id)}
                          >
                            修改
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          在编辑器或输入框里按 ? 不会打开本页（避免吞掉代码里的三元符）；Esc 关闭。
        </p>
      </div>
    </Modal>
  );
}
