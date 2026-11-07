import { useEffect, useRef, useState } from "react";
import {
  bmfScaffoldPreview,
  bmfScaffoldWrite,
  type BmfScaffold,
  type BmfScaffoldSpec,
  type BmfSkeleton,
} from "../../lib/bmf";
import { BMF_IDENT } from "../../lib/bmfPath";
import { getConfig } from "../../lib/appConfig";
import { errorToast } from "../../lib/errorToast";
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
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [root, setRoot] = useState("");
  const previewSeq = useRef(0);

  // 工作区根只在打开时读一次：用户若同时改了设置，下次打开会拿到新值。
  useEffect(() => {
    void getConfig().then((c) => setRoot((c.workspace_root ?? "").replace(/\\/g, "/").replace(/\/+$/, "")));
  }, []);

  /** 改生成参数 → 旧预览立即失效；目标路径不属于生成参数，改它不该让骨架预览作废。 */
  const patchSpec = (p: Partial<Form>) => {
    previewSeq.current++;
    setForm((f) => ({ ...f, ...p }));
    setScaffold(null);
    setPreviewKey(null);
  };
  const patchTarget = (target: string) => setForm((f) => ({ ...f, target }));

  // 与后端 normalize_ident 同口径：先小写再校验，大写输入不会生成大小写不一致的文件名。
  const code = form.code.trim().toLowerCase();
  const module = form.module.trim().toLowerCase();
  const codeOk = BMF_IDENT.test(code);
  const moduleOk = BMF_IDENT.test(module);
  const defsText = form.defs.trim();
  const defsOk = defsText === "" || (/^\d+$/.test(defsText) && Number(defsText) <= 50);
  const defs = defsText === "" ? null : Number(defsText);

  // 目标路径跟着「工作区根 + 模块 + 编码」实时推导；用户手填了就以手填为准。
  // 不能像早先那样把推导值写进 state：先打开、后填编码，路径就永远停在占位符上。
  const derivedTarget = root && codeOk && moduleOk ? `${root}/${module}/METADATA/${code}.bmf` : "";
  const customTarget = form.target.trim().replace(/\\/g, "/");
  const target = customTarget || derivedTarget;
  // 不在 METADATA 下的文件索引扫不到；扩展名不对也不会进索引。
  const targetOk = !!target && /(^|\/)METADATA\/[^/]+\.bmf$/i.test(target);
  const targetStem = target.split("/").pop()?.replace(/\.bmf$/i, "").toLowerCase() ?? "";
  const stemOk = !target || targetStem === code;

  const spec: BmfScaffoldSpec = {
    code,
    name: form.name.trim(),
    module,
    skeleton: form.skeleton,
    defs,
  };
  const previewFresh = !!scaffold && previewKey === JSON.stringify(spec);
  const canPreview = codeOk && moduleOk && !!form.name.trim() && defsOk;

  const preview = async () => {
    if (!canPreview) {
      toast("先修正组件编码 / 模块 / 名称 / 自定义项数量", "info");
      return;
    }
    const seq = ++previewSeq.current;
    const key = JSON.stringify(spec);
    setBusy(true);
    try {
      const r = await bmfScaffoldPreview(spec);
      if (seq !== previewSeq.current) return;
      setScaffold(r);
      setPreviewKey(key);
    } catch (e) {
      errorToast("预览骨架", e);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!target) {
      toast("先打开工作区并填写组件编码（或手填目标路径）", "info");
      return;
    }
    if (!targetOk) {
      toast("目标必须位于 METADATA 目录下并以 .bmf 结尾", "error");
      return;
    }
    if (!stemOk) {
      toast("目标文件名应与组件编码一致", "error");
      return;
    }
    if (!previewFresh) {
      toast("先预览骨架，并确认之后没有再改生成参数", "info");
      return;
    }
    setBusy(true);
    try {
      const p = await bmfScaffoldWrite(spec, target);
      toast("组件已创建", "success");
      onCreated(p);
    } catch (e) {
      errorToast("创建组件", e);
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
          <Input
            value={form.code}
            onChange={(e) => patchSpec({ code: e.target.value })}
            placeholder="如 demo（字母开头）"
            aria-invalid={!codeOk || undefined}
          />
          {!codeOk && <span className="meta-field-error">小写字母开头，只能用小写字母、数字、下划线</span>}
        </label>
        <label>
          <span>中文名</span>
          <Input value={form.name} onChange={(e) => patchSpec({ name: e.target.value })} placeholder="如 演示单据" />
        </label>
        <label>
          <span>模块 / 命名空间</span>
          <Input
            value={form.module}
            onChange={(e) => patchSpec({ module: e.target.value })}
            placeholder="如 uapbd"
            aria-invalid={!moduleOk || undefined}
          />
          {!moduleOk && <span className="meta-field-error">小写字母开头，只能用小写字母、数字、下划线</span>}
        </label>
        <label>
          <span>自定义项数量（0–50）</span>
          <Input
            value={form.defs}
            onChange={(e) => patchSpec({ defs: e.target.value })}
            inputMode="numeric"
            aria-invalid={!defsOk || undefined}
          />
          {!defsOk && <span className="meta-field-error">必须是 0–50 的整数</span>}
        </label>
      </div>

      <div className="meta-skeleton-list">
        {SKELETONS.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`meta-skeleton ${form.skeleton === s.key ? "is-active" : ""}`}
            onClick={() => patchSpec({ skeleton: s.key })}
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
          onChange={(e) => patchTarget(e.target.value)}
          placeholder={derivedTarget || "先打开工作区；目标已存在会被拒绝"}
          title={target}
          aria-invalid={!targetOk || !stemOk || undefined}
        />
        {/* 索引只扫 METADATA 目录；路径不在这里，文件建出来也看不见。 */}
        {target && !targetOk && <span className="meta-field-error">目标必须位于 METADATA 目录下并以 .bmf 结尾</span>}
        {targetOk && !stemOk && <span className="meta-field-error">目标文件名应与组件编码一致：{code}.bmf</span>}
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
        <Button variant="outline" onClick={() => void preview()} disabled={busy || !canPreview}>
          预览
        </Button>
        <Button onClick={() => void save()} disabled={busy || !previewFresh || !targetOk || !stemOk}>
          创建文件
        </Button>
      </div>
    </Dialog>
  );
}
