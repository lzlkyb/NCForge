import { useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { useDialogDismiss } from "../../hooks/useDialogDismiss";
import { createJavaType, javaPreview, type JavaKind, type JavaPreview } from "../../lib/workspace";

const KINDS: { kind: JavaKind; label: string; hint: string }[] = [
  { kind: "class", label: "类", hint: "class" },
  { kind: "interface", label: "接口", hint: "interface" },
  { kind: "enum", label: "枚举", hint: "enum" },
  { kind: "bgplugin", label: "后台插件", hint: "NC 任务" },
];

/** NC 的接口都叫 `IXxx`：名字这样开头就默认选接口（用户手动选过类型后不再自动切）。 */
export const guessKind = (name: string): JavaKind => (/^I[A-Z]/.test(name) ? "interface" : "class");

/** 把目录显示成相对工作区根的写法，找不到就原样给。 */
const relPath = (root: string, path: string) => {
  const n = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = n(root);
  const p = n(path);
  return p.toLowerCase().startsWith(r.toLowerCase() + "/") ? p.slice(r.length + 1) : p;
};

/**
 * 「新建 Java 类型」：选类型、起名字，包名由目录推出并只读展示，下方是将写入文件的内容。
 * 预览走后端（`fs_java_preview`），和真正创建用的是同一套规则，所以所见即所得。
 */
export function NewJavaTypeDialog({
  root,
  parent,
  onClose,
  onCreated,
}: {
  root: string;
  parent: string;
  onClose: () => void;
  onCreated: (path: string) => void;
}) {
  const { closing, dismiss } = useDialogDismiss(onClose, true);
  const [kind, setKind] = useState<JavaKind>("class");
  const [picked, setPicked] = useState(false);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<JavaPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    const timer = setTimeout(() => {
      javaPreview(parent, name, kind)
        .then((p) => { if (id === seq.current) setPreview(p); })
        .catch((e) => { if (id === seq.current) setFailure(String(e)); });
    }, 120);
    return () => clearTimeout(timer);
  }, [parent, name, kind]);

  const onName = (value: string) => {
    const v = value.replace(/\.java$/i, "").trim();
    setName(v);
    setFailure(null);
    if (!picked) setKind(guessKind(v));
  };
  const canCreate = !!preview && !preview.error && !busy && !closing && name !== "";
  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      const path = await createJavaType(parent, name, kind);
      dismiss(() => onCreated(path));
    } catch (e) {
      setFailure(String(e));
      setBusy(false);
    }
  };
  // 空名字时不报「请输入名字」：刚打开就一片红是在骂人，只让「创建」保持禁用
  const nameError = failure ?? (name === "" ? null : preview?.error ?? null);

  return (
    <Modal open={!closing} ariaLabel="新建 Java 类型" onClose={() => dismiss()} className="nj-dialog">
      <div className="nj-head">
        新建 Java 类型
        <button type="button" className="nj-x" aria-label="关闭" onClick={() => dismiss()}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="nj-body">
        <div>
          <span className="nj-lbl">类型</span>
          <div className="nj-kinds" role="radiogroup" aria-label="类型">
            {KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                role="radio"
                aria-checked={kind === k.kind}
                className="nj-kind"
                onClick={() => { setKind(k.kind); setPicked(true); }}
              >
                <b>{k.label}</b>
                <small>{k.hint}</small>
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="nj-lbl" htmlFor="nj-name">名字</label>
          <div className="nj-field" data-bad={nameError ? "" : undefined}>
            <input
              id="nj-name"
              autoFocus
              value={name}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => onName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
              }}
            />
            <span className="nj-suffix">.java</span>
          </div>
          {nameError && <div className="nj-err" role="alert">{nameError}</div>}
        </div>
        <div className="nj-meta">
          <span>包名</span>
          {preview?.package ? (
            <code>{preview.package}</code>
          ) : (
            <span className="nj-warn">无（写入默认包）— 目录不在 src/public|client|private 下</span>
          )}
          <span>位置</span>
          <code>{relPath(root, parent)}</code>
        </div>
        {preview && !preview.error && preview.text && (
          <div>
            <span className="nj-lbl">将写入</span>
            <pre className="nj-pv">{preview.text.replace(/\r\n/g, "\n")}</pre>
          </div>
        )}
      </div>
      <div className="nj-foot">
        <span className="nj-hint">
          {preview?.error && name === "" ? "名字需以大写字母开头，只含字母、数字、下划线" : `换行符跟随同目录：${preview?.eol ?? "CRLF"}`}
        </span>
        <Button variant="outline" size="sm" onClick={() => dismiss()}>取消</Button>
        <Button size="sm" disabled={!canCreate} isLoading={busy} onClick={() => void submit()}>创建并打开</Button>
      </div>
    </Modal>
  );
}
