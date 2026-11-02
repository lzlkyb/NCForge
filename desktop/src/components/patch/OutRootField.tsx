import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { Modal } from "../ui/Modal";
import { toast } from "../ui/toast";
import { failureText } from "../../lib/friendlyError";
import { patchSetOutRoot } from "../../lib/patch";

/**
 * 补丁页顶部「产物根」的人工指定入口。
 *
 * 自动探测按 `<工作区>/out` → 各模块 `classes` 的顺序找；但 Eclipse 编译到 out、
 * 工作台编译到 classes 时两套会同时存在，必须让用户决定以哪套为准
 * （后端 `config.rs` 的 `patch_out_root` 注释也是这个口径）。留空 = 恢复自动探测。
 */
export function OutRootField({
  value,
  detected,
  candidates,
}: {
  /** 用户显式指定的产物根；null = 自动。 */
  value: string | null;
  /** 本次扫描实际用到的产物根（未指定时显示它，便于确认扫的是哪套）。 */
  detected: string[];
  /** 候选目录：显式指定 / 工作区 out / 各模块 classes。 */
  candidates: string[];
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const shown = value ?? (detected.length > 0 ? detected.join("、") : "未探测");

  const save = async (dir: string | null) => {
    setSaving(true);
    try {
      await patchSetOutRoot(dir);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["patch-defaults"] }),
        qc.invalidateQueries({ queryKey: ["patch-scan"] }),
      ]);
      toast(dir ? "产物根已指定，已按新目录重扫" : "已恢复自动探测产物根", "success");
      setOpen(false);
    } catch (e) {
      toast(failureText("保存产物根", e), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <span className="pk-kv">
        产物根 <b title={shown}>{shown}</b>
        <button
          type="button"
          className="pk-link"
          title={value ? "更改或恢复自动探测" : "手动指定编译产物根"}
          onClick={() => {
            setDraft(value ?? "");
            setOpen(true);
          }}
        >
          {value ? "更改" : "指定"}
        </button>
      </span>
      <Modal
        open={open}
        onClose={() => {
          if (!saving) setOpen(false);
        }}
        className="modal-surface w-[600px] max-w-[92vw] p-5"
        ariaLabel="指定编译产物根"
      >
        <div className="flex items-center gap-2">
          <Icon name="package" size={15} />
          <h2 className="text-sm font-semibold">指定编译产物根</h2>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          补丁按这个目录找 <code>.class</code>。留空 = 自动探测（工作区 <code>out/</code> 与各模块{" "}
          <code>classes/</code>）。Eclipse 编到 <code>out</code>、工作台编到 <code>classes</code>{" "}
          时两套会同时存在，用它决定以哪套为准。
        </p>
        <Input
          className="mt-3 font-mono text-xs"
          value={draft}
          placeholder={candidates[0] ?? "D:\\work\\newar\\out"}
          spellCheck={false}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !saving) void save(draft.trim() || null);
          }}
        />
        {candidates.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {candidates.map((c) => (
              <button
                key={c}
                type="button"
                className="pk-link max-w-full truncate"
                title={c}
                onClick={() => setDraft(c)}
              >
                {c}
              </button>
            ))}
          </div>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">目录必须已存在；保存后立即重扫。</p>
        <div className="mt-4 flex items-center gap-2">
          {value && (
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => void save(null)}>
              恢复自动探测
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="outline" size="sm" disabled={saving} onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button size="sm" isLoading={saving} onClick={() => void save(draft.trim() || null)}>
            保存
          </Button>
        </div>
      </Modal>
    </>
  );
}
