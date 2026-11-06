import { useEffect, useRef, useState } from "react";
import { bmfNodeSource } from "../../lib/bmf";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";

/** 大模型只在用户查看时取单个节点源码，不把整份 XML 复制进常驻详情。 */
export function MetaSourcePeek({ path, id, sha, raw = "", disabled = false, draft = false }: {
  path: string; id: string; sha: string; raw?: string; disabled?: boolean; draft?: boolean;
}) {
  const [state, setState] = useState({ open: false, busy: false, text: "", error: null as string | null });
  const token = useRef({ value: 0 });
  useEffect(() => { const pending = token.current; pending.value++; setState({ open: false, busy: false, text: "", error: null }); return () => { pending.value++; }; }, [path, id, sha]);
  const load = async () => {
    const seq = ++token.current.value;
    setState({ open: true, busy: !raw, text: raw, error: null });
    if (raw) return;
    try {
      const text = await bmfNodeSource(path, id, sha);
      if (seq === token.current.value) setState({ open: true, busy: false, text, error: null });
    } catch (error) { if (seq === token.current.value) setState({ open: true, busy: false, text: "", error: String(error) }); }
  };
  return <>
    <button type="button" className="meta-link" disabled={disabled || draft} title={draft ? "保存草稿后查看原始文件内容" : undefined} onClick={() => void load()}>查看原始 XML</button>
    <Dialog open={state.open} ariaLabel="元数据原始 XML" onClose={() => { token.current.value++; setState((s) => ({ ...s, open: false })); }} zIndex={1250}>
      <DialogHeader><DialogTitle>原始 XML · 只读</DialogTitle></DialogHeader>
      {state.busy ? <p className="meta-note" role="status">正在读取这个节点…</p> : state.error ? <div className="meta-error-box" role="alert"><pre>{state.error}</pre><Button variant="outline" size="sm" onClick={() => void load()}>重试</Button></div>
        : <pre className="meta-diff meta-draft-diff" aria-label="节点原始 XML">{state.text}</pre>}
    </Dialog>
  </>;
}
