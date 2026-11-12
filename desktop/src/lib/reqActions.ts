/**
 * 需求的界面动作（新建 / 改名 / 归入 / 出包 / 复制清单）。组件只管按钮，失败提示统一在这里弹。
 */
import { toast } from "../components/ui/toast";
import { askReqName } from "../components/svn/ReqNameDialog";
import { loadPatchDraft, savePatchDraft } from "./patchDraft";
import { EMPTY_DRAFT } from "./patch";
import { getRequirements, reqClaim, reqCreate, reqMerge, reqRecordPackage, reqRename, reqSetStatus, type ReqView, type Requirement } from "./requirements";
import { openPatchPage } from "./svnSession";
import type { ChangeItem } from "./svn";

const fail = (what: string) => (e: unknown) => { toast(`${what}失败：${String(e)}`, "error"); return null; };

/** 和后端 `normalize_name` 同一口径的宽松比较：去首尾空白、连续空白压成一个、不分大小写。 */
const loose = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
export function findReqByName(view: ReqView, name: string): Requirement | undefined {
  const n = loose(name);
  return view.reqs.find((r) => loose(r.name) === n || r.aliases.some((a) => loose(a) === n));
}

/** 新建需求，返回新需求 id；用户取消或失败返回 null。 */
export async function createRequirement(): Promise<string | null> {
  const name = await askReqName({ title: "新建需求", confirm: "新建" });
  if (!name) return null;
  const view = await reqCreate(name).catch(fail("新建需求"));
  return view ? findReqByName(view, name)?.id ?? null : null;
}

export async function renameRequirement(req: Requirement): Promise<void> {
  const name = await askReqName({ title: "需求改名", initial: req.name, confirm: "改名" });
  if (!name || name === req.name) return;
  if (await reqRename(req.id, name).catch(fail("改名"))) toast("已改名，旧名字仍能匹配 AI 之后的声明", "success");
}

/** 把文件归入需求；`id = "new"` 先新建。 */
export async function claimFiles(paths: string[], id: string | "new"): Promise<void> {
  if (!paths.length) return;
  const target = id === "new" ? await createRequirement() : id;
  if (!target) return;
  if (await reqClaim(paths, target).catch(fail("归入需求"))) toast(`已归入 ${paths.length} 个文件`, "success");
}

/** 把 `req` 并入 `into`：文件、认领、出包记录都转过去，`req` 的名字进 `into` 的别名。 */
export async function mergeRequirement(req: Requirement, into: string): Promise<void> {
  if (await reqMerge(req.id, into).catch(fail("合并需求"))) toast(`已并入，「${req.name}」作为别名保留`, "success");
}

export async function closeRequirement(req: Requirement): Promise<void> {
  if (await reqSetStatus(req.id, false).catch(fail("关闭需求"))) toast(`已关闭「${req.name}」，它的文件回到未认领或别的需求`, "success");
}

export async function copyFileList(items: readonly ChangeItem[]): Promise<void> {
  try {
    await navigator.clipboard.writeText(items.map((it) => it.rel).join("\n"));
    toast(`已复制 ${items.length} 个文件`, "success");
  } catch (e) { fail("复制")(e); }
}

/**
 * 「用这个需求出包」：把补丁草稿的名字换成需求名、勾选换成本需求的文件，再跳到打包页。
 * 草稿里已有的 SQL、手写说明、改判的层都保留（可能就是为这个需求写的）。
 */
export function packRequirement(root: string, req: Requirement, items: readonly ChangeItem[]): void {
  const draft = loadPatchDraft(root) ?? { desc: "", draft: { ...EMPTY_DRAFT }, sqls: [], picked: null, layers: [] };
  savePatchDraft(root, { ...draft, desc: req.name, picked: items.map((it) => it.path) });
  openPatchPage();
}

/** 打包成功后调：补丁名对得上某个需求（含旧名）就记一笔出包，用于「已出包 +N」。失败只警告。 */
export function notePackaged(desc: string, zip: string): void {
  const req = findReqByName(getRequirements().view, desc);
  if (!req) return;
  void reqRecordPackage(req.id, zip).catch((e) => console.warn("记录需求出包失败", e));
}
