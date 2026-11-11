/**
 * 工作区外部的文件改动 → 自动编译队列 + 审查事件订阅。
 *
 * 场景：用 git pull / SVN 更新、别的编辑器或 **AI 工具**批量改文件后，工作台不知道
 * 产物已经过期，也不知道「这一轮改了哪些文件」。
 *
 * 两条通道口径不同（P1-2）：
 * - `listeners` 收的是**所有可审查的文本文件**：AI 改 .xml / .sql / .properties / .js
 *   同样要进时间线、让色条重算、让已审角标失效；只认 .java 会静默漏掉一半改动。
 * - 自动编译 `targets` 仍然只认 `.java`：编译单位是 Java 源码，别的类型不进 JVM 队列。
 *
 * 三道闸：
 * 1. 本应用刚保存过的文件不重复报（`isRecentLocalSave`）；
 * 2. 不是工作区里的 `.java` 不自动编（关联工程有自己的 `.classpath`）；
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

/** 二进制 / 构建产物目录：这些改动不值得进审查时间线。 */
const SKIP_EXT = /\.(?:class|jar|war|ear|zip|7z|gz|rar|png|jpe?g|gif|webp|bmp|ico|pdf|exe|dll|so|dylib|pdb|obj|o|pyc|db|sqlite|woff2?|ttf|eot|mp4|avi|mov|wasm|node)$/i;
const SKIP_DIR = /(?:^|\/)(?:\.git|\.svn|node_modules|target|build|classes|\.nc-compile|dist|out)(?:\/|$)/i;

export function isReviewableChange(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return !SKIP_EXT.test(p) && !SKIP_DIR.test(p);
}

let overflowNotifiedAt = 0;
let reviewOverflowNotifiedAt = 0;

/**
 * 外部改动的订阅（刷新已打开的标签 / 时间线 / 色条 / 已审角标用）。独立于自动编译开关：
 * 就算关了自动编译，磁盘上变了的文件在编辑器里也该是新的，不然下次保存就是冲突。
 * 已排除本应用刚保存的文件，所以订阅方看到的都是真的「别的程序改了」。
 */
type Listener = (paths: readonly string[]) => void;
const listeners = new Set<Listener>();
export function onExternalJavaChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * 处理一批外部改动。
 *
 * 两个通道口径不同（P1-2），所以分开传：
 * - `paths` / `overflow`：**编译通道**，只认 `.java`（编译单位是 Java 源码）；
 * - `reviewPaths` / `reviewOverflow`：**审查通道**，所有可审查文本文件都要进
 *   时间线、让色条重算、让已审角标失效。默认等于编译通道（老调用方不传也能跑），
 *   工作台自己的监听会把后端的 `reviewChanged` 单独传进来。
 */
export function handleExternalJavaChanges(
  paths: readonly string[],
  overflow: boolean,
  reviewPaths: readonly string[] = paths,
  reviewOverflow: boolean = overflow,
): void {
  const external = reviewPaths.filter((p) => isReviewableChange(p) && !isRecentLocalSave(p));
  if (external.length > 0) listeners.forEach((cb) => cb(external));
  // 审查通道溢出：时间线不可能逐个文件记（一次 git checkout 几千个文件），
  // 提示用户手动刷新，别静默丢。
  if (reviewOverflow && Date.now() - reviewOverflowNotifiedAt > 60_000) {
    reviewOverflowNotifiedAt = Date.now();
    toast("检测到大量外部文本改动，已跳过逐文件审查刷新；请手动刷新文件树", "info");
  }
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
      toast("检测到大量 Java 外部改动，已跳过自动编译；请手动「编译全部模块」", "info");
    }
    return;
  }
  for (const p of targets) queueAutoCompile(p);
}
