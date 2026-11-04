import { useState } from "react";
import { bmfEditPreview, bmfEditSave, type BmfAttr, type BmfEditOp, type BmfEntity } from "../../lib/bmf";
import { toast } from "../ui/toast";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

/**
 * 字段编辑：先预览 diff，再保存。
 *
 * 两道门都是刻意的——BMF 里有一堆 UAP Studio 才认识的属性，改错一个字节
 * 就可能让官方工具拒绝打开。编辑器只碰用户填的这几个 XML 属性，预览里能看清
 * 到底改了哪一行；保存时后端还会做 SHA-256 冲突检查与备份。
 */
export function MetaEditDialog({
  path,
  sha,
  entity,
  attr,
  onClose,
  onSaved,
}: {
  path: string;
  /** 打开组件时的 SHA-256：保存前由后端复核，外部改过就拒绝。 */
  sha: string;
  entity: BmfEntity;
  attr: BmfAttr | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const adding = attr === null;
  const [name, setName] = useState(attr?.name ?? "");
  const [displayName, setDisplayName] = useState(attr?.displayName ?? "");
  const [length, setLength] = useState(attr?.length == null ? "" : String(attr.length));
  const [nullable, setNullable] = useState(attr?.nullable ?? true);
  const [defaultValue, setDefaultValue] = useState(attr?.defaultValue ?? "");
  const [diff, setDiff] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ops = (): BmfEditOp[] => {
    if (adding) {
      return [
        {
          op: "addAttribute",
          entity: entity.id,
          name: name.trim(),
          displayName: displayName.trim() || name.trim(),
          typeName: "String",
          dbType: "varchar",
          length: length.trim() ? Number(length) : 101,
          nullable,
          defaultValue: defaultValue.trim(),
        },
      ];
    }
    const out: BmfEditOp[] = [];
    const a = attr!;
    if (displayName !== a.displayName) {
      out.push({ op: "setAttr", id: a.id, name: "displayName", value: displayName });
    }
    const len = length.trim() === "" ? null : Number(length);
    if (len !== a.length) {
      out.push({ op: "setAttr", id: a.id, name: "length", value: len == null ? "" : String(len) });
    }
    if (nullable !== a.nullable) {
      out.push({ op: "setAttr", id: a.id, name: "isNullable", value: nullable ? "true" : "false" });
    }
    if (defaultValue !== a.defaultValue) {
      out.push({ op: "setAttr", id: a.id, name: "defaultValue", value: defaultValue });
    }
    return out;
  };

  const preview = async () => {
    setBusy(true);
    try {
      const list = ops();
      if (list.length === 0) {
        setDiff("没有变化。");
        return;
      }
      setDiff(await bmfEditPreview(path, list));
    } catch (e) {
      toast(`预览失败：${e}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const list = ops();
    if (list.length === 0) {
      toast("没有需要保存的修改", "info");
      return;
    }
    setBusy(true);
    try {
      const r = await bmfEditSave(path, list, sha);
      toast(r.changed ? `已保存${r.backup ? "（已备份）" : ""}` : "文件没有变化", "success");
      onSaved();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} ariaLabel={adding ? "新增字段" : "编辑字段"} zIndex={1200}>
      <DialogHeader>
        <DialogTitle>
          {adding ? "新增字段" : `编辑字段 ${attr?.name}`}
          <span className="ml-2 text-[11px] font-normal text-muted-foreground">{entity.name}</span>
        </DialogTitle>
      </DialogHeader>

      <div className="meta-form">
        {adding && (
          <label>
            <span>字段名</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 vbillcode" />
          </label>
        )}
        <label>
          <span>显示名</span>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="界面上的中文名" />
        </label>
        <label>
          <span>{adding ? "长度（默认 101）" : "长度"}</span>
          <Input value={length} onChange={(e) => setLength(e.target.value)} inputMode="numeric" placeholder="空 = 不写" />
        </label>
        <label className="meta-check">
          <input type="checkbox" checked={nullable} onChange={(e) => setNullable(e.target.checked)} />
          <span>允许为空（isNullable）</span>
        </label>
        <label>
          <span>默认值</span>
          <Input value={defaultValue} onChange={(e) => setDefaultValue(e.target.value)} placeholder="留空 = 不写" />
        </label>
      </div>

      {diff != null && (
        <pre className="meta-diff" aria-label="修改预览">
          {diff || "（无差异）"}
        </pre>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button variant="outline" onClick={() => void preview()} disabled={busy}>
          预览 diff
        </Button>
        <Button onClick={() => void save()} disabled={busy || (adding && !name.trim())}>
          保存
        </Button>
      </div>
    </Dialog>
  );
}
