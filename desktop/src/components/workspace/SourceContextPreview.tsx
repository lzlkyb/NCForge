import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { readFile, baseName } from "../../lib/workspace";
import { workspaceEpoch } from "../../lib/workspaceEpoch";
import { sourceContext } from "../../lib/diagnosticScope";
import "../../diagnostic-workspace.css";

export function SourceContextPreview({ path, line, identity, originLabel = "诊断结果", onOpen, onClose }: { path: string; line: number; identity: unknown; originLabel?: string; onOpen: () => void; onClose: () => void }) {
  const [content, setContent] = useState<{ path: string; line: number; identity: unknown; rows: ReturnType<typeof sourceContext>; origin: string } | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    const request = ++sequence.current, epoch = workspaceEpoch(); let alive = true;
    setContent(null); setError("");
    void (async () => {
      try {
        const { getText } = await import("../../lib/editorStore");
        let text = getText(path), origin = "当前编辑器内容";
        if (text === undefined) { text = (await readFile(path)).text; origin = "当前磁盘内容"; }
        if (alive && request === sequence.current && epoch === workspaceEpoch()) setContent({ path, line, identity, rows: sourceContext(text, line), origin });
      } catch (error) { if (alive && request === sequence.current && epoch === workspaceEpoch()) setError(String(error)); }
    })();
    return () => { alive = false; };
  }, [path, line, identity, retry]);
  const current = content?.path === path && content.line === line && content.identity === identity ? content : null;
  return <section className="dw-source-preview" aria-label="源码上下文预览">
    <header><strong title={path}>{baseName(path)}:{line}</strong><span>{current?.origin ?? ""} · 行号来自{originLabel}</span><button type="button" className="wb-status-btn" onClick={onOpen}>打开源码</button><button type="button" className="wb-icon-btn" aria-label="关闭上下文预览" onClick={onClose}><Icon name="close" size={13} /></button></header>
    {error ? <div className="dw-preview-error" role="alert">读取上下文失败：{error}<button type="button" className="wb-status-btn" onClick={() => setRetry(value => value + 1)}>重试</button></div> : !current ? <div className="dw-preview-loading" role="status"><Icon name="spinner" size={13} className="animate-spin" />正在读取上下文…</div> : <div className="dw-preview-code">{current.rows.map(row => <div key={row.line} data-current={row.current || undefined}><span>{row.line}</span><code>{row.text || " "}</code></div>)}</div>}
  </section>;
}
