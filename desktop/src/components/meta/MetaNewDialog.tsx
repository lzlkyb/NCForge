import { useEffect, useState } from "react";
import {
  bmfScaffoldPreview,
  bmfScaffoldWrite,
  type BmfScaffold,
  type BmfScaffoldSpec,
  type BmfSkeleton,
} from "../../lib/bmf";
import { getConfig } from "../../lib/appConfig";
import { toast } from "../ui/toast";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

const SKELETONS: { key: BmfSkeleton; label: string; hint: string }[] = [
  { key: "headBody", label: "主子表", hint: "表头 + 表体 + 聚合关系" },
  { key: "treeCard", label: "树卡", hint: "表头带 pk_parent" },
  { key: "singleHead", label: "单主表", hint: "只有表头" },
  { key: "singleBody", label: "单子表", hint: "只有表体" },
  { key: "free", label: "自由组件", hint: "无实体，纯壳" },
];

interface Form {
  code: string;
  name: string;
  module: string;
  skeleton: BmfSkeleton;
  defs: string;
  target: string;
}

const EMPTY: Form = {
  code: "",
  name: "",
  module: "uapbd",
  skeleton: "headBody",
  defs: "20",
  target: "",
};

/**
 * 新建组件向导（M1）。
 *
 * 只新增一个不存在的文件：目标已存在就拒绝，父目录不存在才创建。
 * 生成前后端会先用解析器把自研 BMF 过一遍（结构 + ID 引用图），不对就当场报错，
 * 不把坏文件交给用户。
 */
export function MetaNewDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (path: string) => void;
}) {
  const [form, setForm] = useState<Form>(EMPTY);
  const [scaffold, setScaffold] = useState<BmfScaffold | null>(null);
  const [busy, setBusy] = useState(false);
  const [root, setRoot] = useState("");

  // 工作区根只在打开时读一次：用户若同时改了设置，下次打开会拿到新值。
  useEffect(() => {
    void getConfig().then((c) => setRoot((c.workspace_root ?? "").replace(/\\/g, "/")));
  }, []);

  const patch = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));

  // 目标路径跟着「工作区根 + 模块 + 编码」实时推导；用户手填了就以手填为准。
  // 不能像早先那样把推导值写进 state：先打开、后填编码，路径就永远停在占位符上。
  const derivedTarget =
    root && form.code.trim() ? `${root}/${form.module.trim()}/METADATA/${form.code.trim()}.bmf` : "";
  const target = form.target.trim() || derivedTarget;

  const spec: BmfScaffoldSpec = {
    code: form.code.trim(),
    name: form.name.trim(),
    module: form.module.trim(),
    skeleton: form.skeleton,
    defs: form.defs.trim() === "" ? null : Number(form.defs),
  };

  const preview = async () => {
    setBusy(true);
    try {
      setScaffold(await bmfScaffoldPreview(spec));
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!target) {
      toast("先打开工作区并填写组件编码（或手填目标路径）", "info");
      return;
    }
    setBusy(true);
    try {
      const p = await bmfScaffoldWrite(spec, target);
      toast("组件已创建", "success");
      onCreated(p);
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} ariaLabel="新建元数据组件" zIndex={1200}>
      <DialogHeader>
        <DialogTitle>新建元数据组件</DialogTitle>
      </DialogHeader>

      <div className="meta-form meta-form-grid">
        <label>
          <span>组件编码</span>
          <Input value={form.code} onChange={(e) => patch({ code: e.target.value })} placeholder="如 demo（字母开头）" />
        </label>
        <label>
          <span>中文名</span>
          <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="如 演示单据" />
        </label>
        <label>
          <span>模块 / 命名空间</span>
          <Input value={form.module} onChange={(e) => patch({ module: e.target.value })} placeholder="如 uapbd" />
        </label>
        <label>
          <span>自定义项数量（0–50）</span>
          <Input value={form.defs} onChange={(e) => patch({ defs: e.target.value })} inputMode="numeric" />
        </label>
      </div>

      <div className="meta-skeleton-list">
        {SKELETONS.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`meta-skeleton ${form.skeleton === s.key ? "is-active" : ""}`}
            onClick={() => patch({ skeleton: s.key })}
          >
            <strong>{s.label}</strong>
            <span>{s.hint}</span>
          </button>
        ))}
      </div>

      <label className="meta-form mt-3">
        <span>目标路径（留空 = 按工作区自动推导）</span>
        <Input
          value={form.target}
          onChange={(e) => patch({ target: e.target.value })}
          placeholder={derivedTarget || "先打开工作区；目标已存在会被拒绝"}
          title={target}
        />
      </label>

      {scaffold && (
        <div className="meta-scaffold-preview">
          <p>
            {scaffold.entities.length} 个实体 · 表 {scaffold.tables.join(" / ") || "—"}
          </p>
          <p>
            VO：{scaffold.voFiles.join("、") || "—"} · 自定义项 {scaffold.defs}
          </p>
          <pre>{scaffold.text}</pre>
        </div>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button variant="outline" onClick={() => void preview()} disabled={busy || !form.code.trim() || !form.name.trim()}>
          预览
        </Button>
        <Button onClick={() => void save()} disabled={busy || !scaffold || !target}>
          创建文件
        </Button>
      </div>
    </Dialog>
  );
}
