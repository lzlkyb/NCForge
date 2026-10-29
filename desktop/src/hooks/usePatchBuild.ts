import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "../components/ui/toast";
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
  type PatchBuildResult,
} from "../lib/patch";

/**
 * 出包这一步的状态：输出目录、包名描述、CHANGES.md 手写段、挂的 SQL。
 *
 * 独立成 hook 的理由很实际：这些字段彼此独立、全都只在本页用，但**必须一起**
 * 提交给后端（少一个就是一次白跑几十秒的出包）。放在页组件里会把 PatchTab
 * 顶过 300 行门禁，而且「填了一半就点生成」的校验散在 JSX 里更容易漏。
 *
 * `force` 必须和扫描用同一份：后端出包时会**重新扫一遍**，改判层不带下去的话，
 * 界面上显示 hyext、包里落到的却是标准层。
 */
export function usePatchBuild(defaultOutDir: string | null, force: LayerForce = NO_FORCE) {
  const qc = useQueryClient();
  const [outDir, setOutDir] = useState<string | null>(null);
  const [desc, setDesc] = useState("");
  const [draft, setDraft] = useState<MdDraft>(EMPTY_DRAFT);
  const [sqls, setSqls] = useState<string[]>([]);
  const [building, setBuilding] = useState(false);
  const [result, setResult] = useState<PatchBuildResult | null>(null);

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
      // 「zip 条目」含目录条目（与 `zip -r` 的历史包一致）——预览树那边数的是
      // 文件，两个数不是一回事，文案里说清，别让用户以为预览少数了
      toast(`已生成补丁包，共 ${r.entries} 个 zip 条目（含目录）`, "success");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBuilding(false);
    }
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
    result,
    setResult,
    zipName,
    saveOutDir,
    doBuild,
  };
}
