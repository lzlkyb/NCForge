import { useEffect, useState } from "react";
import { invoke } from "../../lib/tauri";
import { friendlyError } from "../../lib/friendlyError";
import { getAppearance } from "../../lib/appearance";
import { getUiDensity } from "../../lib/uiDensity";
import { formatBytes } from "../../lib/resource";
import { Button } from "../ui/button";
import { Modal } from "../ui/Modal";

/** 与 Rust 侧 `diagnostics::PlanItem` 一一对应。 */
interface PlanItem {
  path: string;
  label: string;
  bytes: number;
  present: boolean;
}

type Phase = "loading" | "ready" | "busy" | "done";

/**
 * 导出诊断包前的确认页。
 *
 * 🔴 为什么必须先确认再打包：诊断包是**新的数据外泄面**。行业做法（IDEA 的
 * `Collect Logs and Diagnostic Data`）也是先采集、再弹敏感数据提示、最后才给文件。
 * 这里比它更进一步：逐项列出、可取消任意一项，用户不必先猜「里面有没有我客户的名字」。
 *
 * 🔴 为什么预览与导出分两次调用：预览只 stat 不读内容，打开确认页不该把六份日志
 * 全读进内存（单个日志上限 2 MB）。
 */
export function DiagnosticsExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [items, setItems] = useState<PlanItem[] | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<Phase>("loading");
  const [outPath, setOutPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setPhase("loading");
    setOutPath(null);
    setError(null);
    setSkipped(new Set());
    void invoke<PlanItem[]>("diagnostics_preview")
      .then((list) => {
        if (!alive) return;
        setItems(list);
        setPhase("ready");
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // `export_diagnostics` / `diagnostics_preview` 已返 AppError：走 code 表
        // 出人话，而不是把 `Error: ` 前缀的原文糊在弹窗里
        setError(friendlyError(e));
        setPhase("ready");
      });
    return () => { alive = false; };
  }, [open]);

  const toggle = (path: string) => {
    setSkipped((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const exportNow = async () => {
    if (!items) return;
    setPhase("busy");
    setError(null);
    const include = items.filter((i) => !skipped.has(i.path)).map((i) => i.path);
    try {
      const path = await invoke<string>("export_diagnostics", {
        ui: {
          density: getUiDensity(),
          appearance: getAppearance(),
          theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
          // WebView 版本只能从 UA 拿；Rust 侧会截断到 160 字符。
          webview: navigator.userAgent,
        },
        include,
        outDir: null,
      });
      setOutPath(path);
      setPhase("done");
    } catch (e) {
      setError(friendlyError(e));
      setPhase("ready");
    }
  };

  const chosen = items ? items.filter((i) => !skipped.has(i.path)).length : 0;

  return (
    <Modal open={open} onClose={onClose} ariaLabel="导出诊断包" className="modal-surface w-[var(--w-modal-lg)] p-5">
      <h3 className="mb-1 text-sm font-medium text-foreground">导出诊断包</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        下面这些内容会被打进一个 zip。<strong className="font-medium text-foreground">不含数据库密码、连接串与源码正文。</strong>
        日志里可能有文件路径与 SQL 片段，取消勾选即可排除。
      </p>

      {phase === "loading" && <p className="py-6 text-sm text-muted-foreground">正在清点…</p>}

      {items && (
        <ul className="max-h-[46vh] overflow-auto rounded-md border border-border" aria-label="将要打包的内容">
          {items.map((item) => {
            const on = !skipped.has(item.path);
            return (
              <li key={item.path} className="border-b border-border last:border-b-0">
                <label className={`flex cursor-pointer items-start gap-2 px-3 py-2 ${item.present ? "" : "opacity-50"}`}>
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
                    checked={on}
                    onChange={() => toggle(item.path)}
                    aria-label={`${item.label} ${item.path}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-xs font-medium text-foreground">{item.label}</span>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {item.bytes > 0 ? formatBytes(item.bytes) : "自动生成"}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                      {item.path}
                      {item.present ? "" : "（本次不存在）"}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive" role="alert">{error}</p>
      )}

      {phase === "done" && outPath && (
        <div className="mt-3 rounded-md border border-border px-3 py-2" data-tone="ok">
          <p className="text-xs text-foreground">已导出 {chosen} 项</p>
          <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{outPath}</p>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          {items && phase !== "done" ? `已选 ${chosen} / ${items.length} 项` : ""}
        </span>
        <span className="flex gap-2">
          {phase === "done" && outPath && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void invoke("diagnostics_reveal", { path: outPath }).catch(() => undefined)}
            >
              打开所在位置
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>{phase === "done" ? "关闭" : "取消"}</Button>
          {phase !== "done" && (
            <Button
              size="sm"
              disabled={!items || chosen === 0 || phase === "busy"}
              isLoading={phase === "busy"}
              loadingText="打包中…"
              onClick={() => void exportNow()}
            >
              导出
            </Button>
          )}
        </span>
      </div>
    </Modal>
  );
}
