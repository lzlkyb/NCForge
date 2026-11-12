import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "../components/ui/toast";
import { failureText } from "../lib/friendlyError";
import type { PatchDraft } from "../lib/patchDraft";
import { cancelOperation, getOperations, operationActive } from "../lib/operations";
import { listen } from "../lib/tauri";
import { notePackaged } from "../lib/reqActions";
import {
  EMPTY_DRAFT,
  NO_FORCE,
  composeNote,
  patchBuild,
  patchSetOutDir,
  previewZipName,
  ymd,
  type LayerForce,
  type MdDraft,
  type PatchBuildProgress,
  type PatchBuildResult,
} from "../lib/patch";

/**
 * 出包这一步的状态：输出目录、包名描述、CHANGES.md 手写段、挂的 SQL。
 *
 * 独立成 hook 的理由很实际：这些字段彼此独立、全都只在本页用，但**必须一起**
 * 提交给后端（少一个就是一次白跑几十秒的出包）。放在页组件里会把 PatchWorkspace
 * 顶过 300 行门禁，而且「填了一半就点生成」的校验散在 JSX 里更容易漏。
 *
 * `force` 必须和扫描用同一份：后端出包时会**重新扫一遍**，改判层不带下去的话，
 * 界面上显示 hyext、包里落到的却是标准层。
 *
 * `initial` 是上次没打完的草稿（见 `lib/patchDraft`）：进页时直接回填，
 * 不用先渲染空表单再塞数据——那会先闪一帧空白，还会把用户的第一次输入打断。
 */
export function usePatchBuild(
  defaultOutDir: string | null,
  force: LayerForce = NO_FORCE,
  initial: PatchDraft | null = null,
) {
  const qc = useQueryClient();
  const [outDir, setOutDir] = useState<string | null>(null);
  const [desc, setDesc] = useState(initial?.desc ?? "");
  const [draft, setDraft] = useState<MdDraft>(initial?.draft ?? EMPTY_DRAFT);
  const [sqls, setSqls] = useState<string[]>(initial?.sqls ?? []);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<PatchBuildProgress | null>(null);
  const [result, setResult] = useState<PatchBuildResult | null>(null);

  // 出包最坏几十秒，中间没有任何反馈时用户只能等；后端每写完一个条目推一次。
  useEffect(() => {
    if (!building) return;
    let dead = false;
    let un: (() => void) | undefined;
    listen<PatchBuildProgress>("patch:build-progress", (p) => {
      if (!dead) setProgress(p);
    })
      .then((f) => {
        if (dead) f();
        else un = f;
      })
      .catch(() => undefined);
    return () => {
      dead = true;
      un?.();
    };
  }, [building]);

  // 用户改过就用改过的，否则用后端给的建议值——不做 effect 同步，
  // 否则「切页回来」会把用户刚敲的路径冲掉。
  const dir = outDir ?? defaultOutDir ?? "";
  const zipName = previewZipName(desc, ymd());

  const saveOutDir = async (v: string) => {
    const t = v.trim();
    if (!t) throw new Error("输出目录不能为空");
    await patchSetOutDir(t);
    setOutDir(t);
    void qc.invalidateQueries({ queryKey: ["patch-defaults"] });
  };

  const doBuild = async (files: string[]) => {
    if (operationActive("patch.build")) return;
    if (!desc.trim()) {
      toast("先写一句「改动内容描述」——它就是补丁包的名字", "error");
      return;
    }
    if (!dir) {
      toast("还没选补丁输出目录", "error");
      return;
    }
    if (files.length === 0) {
      toast("没有勾选任何文件", "error");
      return;
    }
    setBuilding(true);
    setProgress(null);
    setResult(null);
    try {
      const r = await patchBuild({
        files,
        outDir: dir,
        desc: desc.trim(),
        note: composeNote(draft),
        sqls,
        date: ymd(),
        forceHyext: force.hy,
        forceStd: force.std,
      });
      setResult(r);
      // 补丁名对得上某个需求就记一笔出包（变更列表的「已出包 +N」靠它）
      notePackaged(desc.trim(), r.zipPath);
      // 「zip 条目」含目录条目（与 `zip -r` 的历史包一致）——预览树那边数的是
      // 文件，两个数不是一回事，文案里说清，别让用户以为预览少数了
      toast(`已生成补丁包，共 ${r.entries} 个 zip 条目（含目录）`, "success");
    } catch (e) {
      const cancelled = String(e instanceof Error ? e.message : e).startsWith("已取消出包");
      toast(cancelled ? String(e) : failureText("生成补丁包", e), cancelled ? "info" : "error");
    } finally {
      setBuilding(false);
      setProgress(null);
    }
  };

  /** 取消出包：只置标志，后端在下一个条目边界退出。按钮置灰即可，不用二次确认。 */
  const doCancel = () => {
    const operation = getOperations().find(o => o.key === "patch.build" && o.state === "running");
    if (operation) void cancelOperation(operation.id);
  };

  return {
    dir,
    desc,
    setDesc,
    draft,
    setDraft,
    sqls,
    setSqls,
    building,
    progress,
    result,
    setResult,
    zipName,
    saveOutDir,
    doBuild,
    doCancel,
  };
}
