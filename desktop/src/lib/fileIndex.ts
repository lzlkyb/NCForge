import { invoke } from "./tauri";
import type { FileEntry } from "./fuzzy";

/**
 * 工作区文件名索引（「转到文件」用）。
 *
 * 后端一次返回全部相对路径（newar 约一万六千个，几十毫秒）。缓存按「过期即重算」处理：打开面板时
 * 先用旧的立刻出结果，后台刷新，下次按键就是新的。文件树里新建 / 改名 / 删除时主动失效。
 */
const TTL_MS = 15_000;

interface FileList {
  files: string[];
  truncated: boolean;
}

let cache: { root: string; at: number; entries: FileEntry[]; truncated: boolean } | null = null;
let inflight: Promise<void> | null = null;

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
}

/** 失效缓存（文件树里新建 / 改名 / 删除后调用）。 */
export function invalidateFileIndex(): void {
  cache = null;
}

/**
 * 取文件条目。有同工程的缓存就直接返回（过期的同时触发后台刷新），没有就等刷新完成。
 * 刷新失败（工作区刚换、目录没了）返回空表，不抛——面板照常可用。
 */
export async function getFileIndex(root: string): Promise<FileEntry[]> {
  const fresh = cache && cache.root === root && Date.now() - cache.at < TTL_MS;
  if (fresh) return cache!.entries;
  const start = (): Promise<void> => {
    inflight ??= refresh(root)
      .catch(() => {})
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
  if (cache && cache.root === root) {
    void start();
    return cache.entries;
  }
  await start();
  return cache && cache.root === root ? cache.entries : [];
}
