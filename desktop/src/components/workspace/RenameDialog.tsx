// 重命名符号（跨文件）。两步：先看会动哪些文件、各几处，再确认写入。
//
// 为什么不一输名字就改：改名是整个工程范围的写操作，NC 里一个 `getBillType` 能有上百处。
// 先给清单（文件名 + 处数），人才能判断「这次是不是真该全改」——比如有同名但不相干的方法时，
// 光看输入框是看不出来的。
import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { baseName } from "../../lib/workspace";
import { applyRenamePlan, planRename, type RenamePlan } from "../../lib/renameSymbol";
import { cursorAt, wordAtCursor } from "../../lib/editorActions";

interface Props {
  open: boolean;
  path: string | null;
  onClose: () => void;
}

export function RenameDialog({ open, path, onClose }: Props) {
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<RenamePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次打开都按当前光标重来：上一次的清单不能留（光标已经换了地方）
  useEffect(() => {
    if (!open) return;
    setName(wordAtCursor());
    setPlan(null);
    setBusy(false);
    setError(null);
  }, [open]);

  const preview = async () => {
    const at = cursorAt();
    if (!path || !at) {
      setError("先把光标放到要改名的符号上（类名、方法名、字段名都可以）");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setPlan(await planRename(path, at.line, at.column, name));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const r = await applyRenamePlan(plan);
      // 分开报：写盘的那部分已经生效，编辑器里的还没保存，混成一句话会让人以为都完事了。
      // 只读标签跳过也要说——不说的话，工程停在「一半新名一半旧名」用户也不知道。
      const done =
        r.inEditor > 0
          ? `已重命名：${r.written} 个文件已写入，${r.inEditor} 个在编辑器里（改动未保存，记得 Ctrl+S）`
          : `已重命名：${r.written} 个文件已写入`;
      const skipped = r.skippedReadOnly.length;
      if (skipped > 0) {
        toast(
          `${done}；另有 ${skipped} 个只读标签（混合换行/编码有损）被跳过，这些文件里的引用没有改名`,
          r.written + r.inEditor === 0 ? "warning" : "success",
        );
      } else {
        toast(done, "success");
      }
      onClose();
    } catch (e) {
      setError(`改名失败：${e}`);
    } finally {
      setBusy(false);
    }
  };

  const total = plan?.groups.reduce((n, g) => n + g.edits.length, 0) ?? 0;

  return (
    // busy 中不给任何关闭途径（Esc 与点遮罩都走 onClose）：查找/写入跑到一半
    // 关掉，用户既看不到清单也不知道到底改没改
    <Modal open={open} ariaLabel="重命名符号" onClose={() => { if (!busy) onClose(); }} className="w-full max-w-lg rounded-[var(--r-card)] modal-surface p-5">
      <h4 className="mb-2 flex items-center gap-2 text-base font-semibold">
        <Icon name="edit" size={18} className="text-muted-foreground" />
        重命名符号
      </h4>
      <p className="mb-3 text-sm text-muted-foreground">
        改的是整个工程里的这个符号（类 / 方法 / 字段），包含还没打开的文件。
      </p>

      <label className="mb-1 block text-xs text-muted-foreground" htmlFor="rename-input">
        新名字
      </label>
      <input
        id="rename-input"
        className="mb-3 w-full rounded-[var(--r-control)] border border-border bg-background px-2 py-1 text-sm"
        autoFocus
        value={name}
        disabled={busy}
        onChange={(e) => {
          setName(e.target.value);
          // 名字改了，上一份清单就作废——不然会拿旧清单去改新名字
          setPlan(null);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !plan) {
            e.preventDefault();
            void preview();
          }
        }}
      />

      {error && <p className="mb-2 text-sm text-destructive-ink">{error}</p>}

      {plan && (
        <div className="mb-2 max-h-56 overflow-y-auto rounded-[var(--r-control)] border border-border">
          <div className="border-b border-border px-2 py-1 text-xs text-muted-foreground">
            {plan.groups.length} 个文件、{total} 处将被改动
          </div>
          {plan.groups.map((g) => (
            <div key={g.path} className="flex items-center gap-2 px-2 py-1 text-xs" title={g.path}>
              <span className="flex-1 truncate">{baseName(g.path)}</span>
              <span className="text-muted-foreground">{g.edits.length} 处</span>
            </div>
          ))}
          {plan.skipped.length > 0 && (
            <div className="border-t border-border px-2 py-1 text-xs text-muted-foreground">
              {plan.skipped.length} 个只读目标（jar 里的类）改不了，会跳过
            </div>
          )}
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
          取消
        </Button>
        {plan ? (
          <Button size="sm" onClick={() => void apply()} disabled={busy}>
            {busy ? "写入中…" : `确认改名（${total} 处）`}
          </Button>
        ) : (
          <Button size="sm" onClick={() => void preview()} disabled={busy || !name.trim()}>
            {busy ? "查找中…" : "下一步：看会改哪些地方"}
          </Button>
        )}
      </div>
    </Modal>
  );
}
