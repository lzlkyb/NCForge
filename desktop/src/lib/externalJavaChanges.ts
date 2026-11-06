/**
 * 工作区外部的 `.java` 改动 → 自动编译队列。
 *
 * 场景：用 git pull / SVN 更新、别的编辑器或脚本批量改文件后，工作台不知道
 * 产物已经过期。监听器会把 `.java` 内容变化一并报上来，这里把它接进与保存
 * 相同的防抖队列（一批只起一轮 JVM）。
 *
 * 三道闸：
 * 1. 本应用刚保存过的文件不重复编（`isRecentLocalSave`）；
 * 2. 不是工作区里的 `.java` 不编（关联工程有自己的 `.classpath`）；
 * 3. 一次事件里文件太多时只提示、不排队——`git checkout` 一个分支几千个文件，
 *    全量编译应该由用户显式发起，而不是保存流程替他决定。
 */
import { queueAutoCompile } from "./autoCompileQueue";
import { isAutoCompileTarget, isJavaFile } from "./autoCompile";
import { autoCompileCached, autoExternalCached } from "./appConfig";
import { isRecentLocalSave } from "./localSaves";
import { getSession } from "./workspaceSession";
import { toast } from "../components/ui/toast";

/** 一次监听批次里超过这个数就不自动编（提示用户手动编译全部）。 */
export const EXTERNAL_BATCH_LIMIT = 64;

let overflowNotifiedAt = 0;

export function handleExternalJavaChanges(paths: readonly string[], overflow: boolean): void {
  if (paths.length === 0 && !overflow) return;
  if (!autoCompileCached() || !autoExternalCached()) return;
  const root = getSession().root ?? null;
  const targets = paths.filter(
    (p) => isJavaFile(p) && !isRecentLocalSave(p) && isAutoCompileTarget(p, root),
  );
  if (overflow || targets.length > EXTERNAL_BATCH_LIMIT) {
    // 每次 git 操作只提示一次；批量编译由用户从构建菜单显式发起
    if (Date.now() - overflowNotifiedAt > 60_000) {
      overflowNotifiedAt = Date.now();
      toast("检测到大量 .java 外部改动，已跳过自动编译；请手动「编译全部模块」", "info");
    }
    return;
  }
  for (const p of targets) queueAutoCompile(p);
}
