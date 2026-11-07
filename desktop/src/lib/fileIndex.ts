import { invoke } from "./tauri";
import type { FileEntry } from "./fuzzy";

/**
 * 工作区文件名索引（「转到文件」用）。
 *
 * 后端一次返回全部相对路径（newar 约一万六千个）。**这里的第一原则是绝不让你等**：
 * - 有旧表就立刻用它，后台去刷新（stale-while-revalidate）；
 * - 只有一份都没有（应用刚启动、刚换工作区）才真的 await。
 *
 * 后端的清单本身也有缓存（进程内 60 秒 + 磁盘 24 小时），所以这里即使 miss，
 * 通常也只是读一次缓存文件。文件树里新建 / 改名 / 删除时仍会主动失效。
 *
 * 以前是 15 秒 TTL：停一会儿再敲一个字母就要等一次全树扫描（1~3 秒），
 * 面板上一直转「查询中…」。实时性靠 `invalidateFileIndex` 主动失效来保证，
 * 不再靠短 TTL 去赌。
 */
const TTL_MS = 5 * 60_000;

interface FileList {
  files: string[];
  truncated: boolean;
}

let cache: { root: string; at: number; entries: FileEntry[]; truncated: boolean } | null = null;
let inflight: Promise<void> | null = null;
/** 被主动失效过：即便还在 TTL 内也值得后台刷一次。 */
let stale = false;

/** 相对路径 → 条目。root 不带尾部分隔符。 */
export function toEntry(root: string, rel: string): FileEntry {
  const slash = rel.lastIndexOf("/");
  return {
    path: `${root}\\${rel.replace(/\//g, "\\")}`,
    rel,
    name: rel.slice(slash + 1),
    dir: slash < 0 ? "" : rel.slice(0, slash),
  };
}

async function refresh(root: string): Promise<void> {
  const base = root.replace(/[\\/]+$/, "");
  const r = await invoke<FileList>("search_list_files");
  cache = { root, at: Date.now(), entries: r.files.map((f) => toEntry(base, f)), truncated: r.truncated };
  stale = false;
}

/** 同一个 root 的刷新合并成一次；不同 root 各自排队。 */
function start(root: string): Promise<void> {
  inflight ??= refresh(root)
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * 失效缓存（文件树里新建 / 改名 / 删除后调用）。
 *
 * 不直接清空：保留旧表让下次打开面板仍然秒开，同时后台校准。删除的文件会在
 * 一个刷新周期后消失——这个短暂不一致比「每次删完文件都要等全树扫描」划算。
 */
export function invalidateFileIndex(): void {
  stale = true;
  void invoke("search_invalidate_files").catch(() => {});
  const root = cache?.root;
  if (root) {
    void start(root);
  } else {
    // 没有任何数据可复用：让下一次取清单走一次完整加载
    inflight = null;
  }
}

/**
 * 同步看一眼缓存（有就返回，没有返回 null，绝不触发加载）。
 *
 * `#内容` 搜索用它把「文件名里就带关键词」的文件排到扫描队首：这一步不能反过来
 * 让搜索先等一次全树扫描，所以只认已经在内存里的那份。
 */
export function peekFileIndex(root: string): FileEntry[] | null {
  return cache && cache.root === root ? cache.entries : null;
}

/**
 * 取文件条目。有同工程的缓存就直接返回（过期或已失效就顺手后台刷新），
 * 没有才等一次加载。刷新失败（工作区刚换、目录没了）返回空表，不抛——面板照常可用。
 */
export async function getFileIndex(root: string): Promise<FileEntry[]> {
  const hit = cache && cache.root === root ? cache : null;
  if (hit && !stale && Date.now() - hit.at < TTL_MS) return hit.entries;
  if (hit) {
    void start(root);
    return hit.entries;
  }
  await start(root);
  return cache && cache.root === root ? cache.entries : [];
}
