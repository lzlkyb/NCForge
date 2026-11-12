/**
 * 需求名输入框（新建 / 改名）。
 *
 * 入口分散在变更列表、状态栏、按需求审查视图，所以做成「调用即弹」：`askReqName()` 返回 Promise，
 * 宿主组件在 App 里只挂一个。名字的清洗与同名拦截在后端，这里只管非空。
 */
import { useState, useSyncExternalStore } from "react";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Input } from "../ui/input";

interface Ask { title: string; initial: string; confirm: string; resolve: (name: string | null) => void }
let current: Ask | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export function askReqName(opts: { title: string; initial?: string; confirm?: string }): Promise<string | null> {
  current?.resolve(null);
  return new Promise((resolve) => {
    current = { title: opts.title, initial: opts.initial ?? "", confirm: opts.confirm ?? "确定", resolve };
    emit();
  });
}

function finish(name: string | null) {
  const ask = current;
  current = null;
  emit();
  ask?.resolve(name);
}

export function ReqNameDialogHost() {
  const ask = useSyncExternalStore(subscribe, () => current, () => null);
  // key 让每次弹出都从 initial 重新开始，而不是留着上次输入的字。
  return ask ? <NameForm key={`${ask.title}:${ask.initial}`} ask={ask} /> : null;
}

function NameForm({ ask }: { ask: Ask }) {
  const [name, setName] = useState(ask.initial);
  const ok = name.trim().length > 0;
  return <ConfirmDialog title={ask.title} confirmLabel={ask.confirm} confirmDisabled={!ok} onCancel={() => finish(null)} onConfirm={() => finish(name.trim())}
    description="建议用补丁名去掉日期，如「7691_平台耗材采购退库…」。出包时补丁名就用它。">
    <Input aria-label="需求名" autoFocus value={name} spellCheck={false} maxLength={120}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && ok) { e.preventDefault(); finish(name.trim()); } }} />
  </ConfirmDialog>;
}
