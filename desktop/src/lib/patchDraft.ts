import { EMPTY_DRAFT, type MdDraft } from "./patch";

/**
 * 补丁页的草稿：改动说明、CHANGES.md 手写段、挂的 SQL、勾选的文件、手动改判的层。
 *
 * **为什么存起来而不是退出时弹框问**：这页填的东西少则十几个字，多则是勾了两屏
 * 的文件清单。弹框问「要不要保存草稿」等于把决策丢给用户，而他此刻只想关电脑。
 * 直接存下来、下次进页原样回填，是这段数据唯一合理的归宿。
 *
 * **按工作区隔离**：草稿里是**绝对路径**（勾选与改判层），换个工作区就全对不上。
 * 共用一份的话，用户在另一个工程里打开补丁页会看到上一个工程的说明文字。
 *
 * 输出目录**不在这里**：它由后端持久化（`patchSetOutDir`），本来就是跨会话的配置，
 * 不是草稿。
 */

const KEY = "ncforge.patchDraft.v1";

export interface PatchDraft {
  /** 改动内容描述——它就是补丁包的文件名。 */
  desc: string;
  /** CHANGES.md 的手写分节。 */
  draft: MdDraft;
  /** 随包挂的 SQL。 */
  sqls: string[];
  /** 手动勾选过的文件路径；`null` = 从没动过（跟着扫描结果默认全勾）。 */
  picked: string[] | null;
  /** 手动改判的层：`[路径, "hy" | "std"]`。 */
  layers: [string, "hy" | "std"][];
}

const keyOf = (root: string | null) => (root ? `${KEY}:${root}` : KEY);

/** 全空就别在 localStorage 里留垃圾（也顺手把上次的删掉）。 */
function isEmpty(d: PatchDraft): boolean {
  if (d.desc.trim() || d.sqls.length > 0 || d.layers.length > 0) return false;
  // `picked` 为 null 是「没动过」，`[]` 是「明确全不勾」——后者是有效意图，不能当空
  if (d.picked !== null) return false;
  return Object.values(d.draft).every((v) => !v.trim());
}

/**
 * 读草稿。没有、或存的内容不合法（手改过 localStorage、旧版本格式）都返回 null，
 * 绝不让一段坏数据把整个补丁页顶崩。
 */
export function loadPatchDraft(root: string | null): PatchDraft | null {
  try {
    const raw = localStorage.getItem(keyOf(root));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PatchDraft>;
    if (typeof v.desc !== "string") return null;
    return {
      desc: v.desc,
      // 逐字段合并：以后给 EMPTY_DRAFT 加分节，老草稿也能读
      draft: { ...EMPTY_DRAFT, ...(v.draft ?? {}) },
      sqls: Array.isArray(v.sqls) ? v.sqls : [],
      picked: Array.isArray(v.picked) ? v.picked : null,
      layers: Array.isArray(v.layers) ? v.layers : [],
    };
  } catch {
    return null;
  }
}

/** 存草稿。存不进去（隐私模式、配额满）不影响打包本身，静默放弃。 */
export function savePatchDraft(root: string | null, d: PatchDraft): void {
  try {
    if (isEmpty(d)) {
      localStorage.removeItem(keyOf(root));
      return;
    }
    localStorage.setItem(keyOf(root), JSON.stringify(d));
  } catch {
    // 忽略：草稿丢失不该阻断出包
  }
}
