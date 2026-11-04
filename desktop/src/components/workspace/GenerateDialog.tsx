// 「生成代码」对话框（Alt+Insert）。
//
// 两块能力合在一个入口，因为用户的心智是「往类里加东西」：
// 1. 本地生成：构造器 / getter / setter / toString / equals / hashCode —— 纯前端，不依赖语言服务；
// 2. 语言服务生成：override / implement —— 由 jdt.ls 的 source action 返回要插入的代码。
//
// 生成结果只插进编辑器，不落盘（红线：工具不替用户写文件）。
import { useEffect, useMemo, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { currentModel, editorSnapshot, insertEditorTextAtLine } from "../../lib/editorActions";
import { indentUnitOf, parseJava } from "../../lib/javaModel";
import {
  generate,
  joinGenerated,
  skipReason,
  summarize,
  type GenKind,
} from "../../lib/javaCodeGen";
import { trackOperation, operationActive } from "../../lib/operations";
import { KINDS, applySourceAction, sourceActions, type JavaSourceAction } from "../../lib/javaActions";

interface Props {
  open: boolean;
  onClose: () => void;
}

const LOCAL_ITEMS: { kind: GenKind; label: string; sub: string }[] = [
  { kind: "constructor", label: "构造器", sub: "用全部非 static 字段做参数" },
  { kind: "getters", label: "Getter", sub: "boolean 字段生成为 isXxx" },
  { kind: "setters", label: "Setter", sub: "跳过 static / final 字段" },
  { kind: "toString", label: "toString", sub: "类名{字段=值, …}" },
  { kind: "equals", label: "equals", sub: "逐字段 Objects.equals" },
  { kind: "hashCode", label: "hashCode", sub: "Objects.hash(字段…)" },
];

export function GenerateDialog({ open, onClose }: Props) {
  const [picked, setPicked] = useState<GenKind[]>(["getters", "setters"]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // override / implement 的动作清单（来自 jdt.ls），为空表示没请求或不支持
  const [members, setMembers] = useState<JavaSourceAction[]>([]);
  const [pickedMembers, setPickedMembers] = useState<number[]>([]);

  // 每次打开都用当前编辑器重算：上一个文件的字段不能留
  const snap = useMemo(() => (open ? editorSnapshot() : null), [open]);
  const parsed = useMemo(() => (snap?.isJava ? parseJava(snap.text) : null), [snap]);
  const opts = useMemo(
    () => ({
      fields: parsed?.fields ?? [],
      className: parsed?.name ?? "",
      indent: snap ? indentUnitOf(snap.text) : "\t",
    }),
    [parsed, snap],
  );

  useEffect(() => {
    if (!open) return;
    setError(snap && !snap.isJava ? "当前文件不是 Java" : parsed ? null : "没认出类声明（光标不需要在类里，但文件要是 .java）");
    setBusy(false);
    setMembers([]);
    setPickedMembers([]);
  }, [open, snap, parsed]);

  const toggle = (k: GenKind) =>
    setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  /** 插入位置：光标在类体里就用光标，否则落在类体末尾（`}` 之前）。 */
  const insertLine = (): number => {
    if (!snap || !parsed) return 1;
    const end = parsed.bodyEndLine >= 0 ? parsed.bodyEndLine + 1 : snap.line;
    return snap.line > 1 && snap.line < end ? snap.line : end;
  };

  const doGenerate = () => {
    if (!parsed) return;
    const text = joinGenerated(picked.map((k) => generate(k, opts)));
    if (!text.trim()) {
      setError(
        picked.map((k) => skipReason(k, opts)).find(Boolean) ?? "没有可生成的内容",
      );
      return;
    }
    if (!insertEditorTextAtLine(text, insertLine())) {
      setError("编辑器不可用");
      return;
    }
    toast(`已生成：${summarize(picked, opts)}（未保存，Ctrl+S 落盘）`, "success");
    onClose();
  };

  const loadMembers = async (which: "override" | "implement") => {
    if (operationActive("language.generate")) return;
    const model = currentModel();
    if (!model) {
      setError("编辑器不可用");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const list = await trackOperation({ key: "language.generate", label: "读取可生成的方法", page: "files", phase: which === "override" ? "查找可覆盖的父类方法" : "查找待实现的接口方法" }, () => sourceActions(model, KINDS[which]), list => ({ state: list.length ? "success" : "cancelled", detail: list.length ? `返回 ${list.length} 项可选动作` : "未返回可用动作，请查看对话框说明" }));
      setMembers(list);
      setPickedMembers(list.map((_, i) => i));
      if (list.length === 0) {
        setError(
          which === "override"
            ? "代码智能没有给出可覆盖的方法（jdt.ls 0.57 可能不支持该 source action，或本类没有父类方法可覆盖）"
            : "代码智能没有给出可实现的接口方法（接口未实现时先看「问题」面板里的编译错误）",
        );
      }
    } catch (e) { setError(String(e)); } finally {
      setBusy(false);
    }
  };

  const applyMembers = async () => {
    if (operationActive("language.generate")) return;
    const model = currentModel();
    if (!model) return;
    setBusy(true);
    try {
      const { applied, skipped } = await trackOperation({ key: "language.generate", label: "生成接口与覆盖方法", page: "files", phase: "应用选中的代码动作" }, async () => {
        let applied = 0, skipped = 0;
        for (const i of pickedMembers) {
          const r = await applySourceAction(model, members[i]);
          if (r) { applied += r.applied; skipped += r.skipped; }
        }
        return { applied, skipped };
      }, r => ({ state: r.applied ? "success" : "failed", detail: `应用 ${r.applied} 处、跳过 ${r.skipped} 处；仅修改编辑器，尚未保存` }));
      if (applied === 0) {
        setError("没有插入任何代码：动作返回的编辑不属于当前文件");
        return;
      }
      toast(
        skipped > 0
          ? `已插入 ${applied} 处；另有 ${skipped} 处落在别的文件，未处理（不替用户改其他文件）`
          : `已插入 ${applied} 处（未保存，Ctrl+S 落盘）`,
        skipped > 0 ? "warning" : "success",
      );
      onClose();
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  const summary = summarize(picked, opts);

  return (
    <Modal
      open={open}
      ariaLabel="生成代码"
      onClose={() => {
        if (!busy) onClose();
      }}
      className="w-full max-w-lg rounded-[var(--r-card)] modal-surface p-5"
    >
      <h4 className="mb-1 flex items-center gap-2 text-base font-semibold">
        <Icon name="sparkles" size={18} className="text-muted-foreground" />
        生成代码
      </h4>
      <p className="mb-3 text-sm text-muted-foreground">
        {parsed
          ? `${parsed.kind === "class" ? "类" : parsed.kind} ${parsed.name} · 识别到 ${opts.fields.length} 个字段`
          : "只对 Java 类生效"}
      </p>

      {opts.fields.length > 0 && (
        <div className="mb-3 max-h-24 overflow-y-auto rounded-[var(--r-control)] border border-border px-2 py-1">
          {opts.fields.map((f) => (
            <div key={f.name} className="flex gap-2 py-0.5 text-xs">
              <span className="text-muted-foreground">{f.type}</span>
              <span>{f.name}</span>
              {f.isStatic && <span className="text-muted-foreground">static</span>}
              {f.isFinal && <span className="text-muted-foreground">final</span>}
            </div>
          ))}
        </div>
      )}

      <div className="mb-3 grid grid-cols-2 gap-1">
        {LOCAL_ITEMS.map((it) => {
          const skip = skipReason(it.kind, opts);
          return (
            <label
              key={it.kind}
              className={`flex items-start gap-2 rounded-[var(--r-control)] border border-border px-2 py-1.5 text-sm ${skip ? "opacity-50" : "cursor-pointer"}`}
              title={skip ?? it.sub}
            >
              <input
                type="checkbox"
                className="mt-0.5"
                disabled={!!skip}
                checked={picked.includes(it.kind)}
                onChange={() => toggle(it.kind)}
              />
              <span className="flex flex-col">
                <span>{it.label}</span>
                <span className="text-xs text-muted-foreground">{skip ?? it.sub}</span>
              </span>
            </label>
          );
        })}
      </div>

      <div className="mb-3 flex gap-2">
        <Button variant="outline" size="sm" disabled={busy || !parsed} onClick={() => void loadMembers("override")}>
          覆盖父类方法…
        </Button>
        <Button variant="outline" size="sm" disabled={busy || !parsed} onClick={() => void loadMembers("implement")}>
          实现接口方法…
        </Button>
      </div>

      {members.length > 0 && (
        <div className="mb-3 max-h-40 overflow-y-auto rounded-[var(--r-control)] border border-border">
          {members.map((m, i) => (
            <label key={i} className="flex cursor-pointer items-center gap-2 px-2 py-1 text-xs">
              <input
                type="checkbox"
                checked={pickedMembers.includes(i)}
                onChange={() =>
                  setPickedMembers((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]))
                }
              />
              <span className="truncate" title={m.title}>
                {m.title}
              </span>
            </label>
          ))}
        </div>
      )}

      {error && <p className="mb-2 text-sm text-destructive-ink">{error}</p>}

      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">
          {summary ? `将生成：${summary}` : "未选择"}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            取消
          </Button>
          {members.length > 0 ? (
            <Button size="sm" onClick={() => void applyMembers()} disabled={busy || pickedMembers.length === 0}>
              {busy ? "插入中…" : `插入所选（${pickedMembers.length}）`}
            </Button>
          ) : (
            <Button size="sm" onClick={doGenerate} disabled={busy || !parsed || picked.length === 0}>
              生成
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
