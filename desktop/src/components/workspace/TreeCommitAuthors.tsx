import { createContext, useContext, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { formatRevTime, svnFileCommits, type StatusLetter, type SvnFileCommit } from "../../lib/svn";
import { pathKey } from "../../lib/treeSvn";
import { dirName } from "../../lib/workspace";
import { TreeSvnContext, type TreeSvnCommitScope } from "./TreeSvnContext";

interface DirectoryCommits {
  files: ReadonlyMap<string, SvnFileCommit> | undefined;
  failed: boolean;
}

const TreeCommitContext = createContext<ReadonlyMap<string, DirectoryCommits>>(new Map());
export const fileCommitKey = (root: string, dir: string) => ["svn-file-commits", root, pathKey(dir)] as const;

// Query only directories that actually contribute file rows, including hoisted files.
export function TreeCommitAuthors({ dirs, children }: { dirs?: Set<string>; children: ReactNode }) {
  const { commitScope } = useContext(TreeSvnContext);
  if (!commitScope || !dirs?.size) return <>{children}</>;
  const prefix = pathKey(commitScope.root);
  const local = [...dirs].filter(dir => {
    const key = pathKey(dir);
    return key === prefix || key.startsWith(prefix + "/");
  });
  if (!local.length) return <>{children}</>;
  return <DirectoryCommitAuthors scope={commitScope} dirs={local}>{children}</DirectoryCommitAuthors>;
}

const indexFiles = (files: SvnFileCommit[]) => new Map(files.map(file => [pathKey(file.path), file]));

function DirectoryCommitAuthors({ scope, dirs, children }: { scope: TreeSvnCommitScope; dirs: string[]; children: ReactNode }) {
  const results = useQueries({ queries: dirs.map(dir => ({
    queryKey: fileCommitKey(scope.root, dir),
    queryFn: () => svnFileCommits(scope.root, dir),
    select: indexFiles,
    staleTime: 30_000,
    retry: false,
  })) }, scope.client);
  const value = new Map(dirs.map((dir, i) => [pathKey(dir), { files: results[i].data, failed: results[i].isError }]));
  return <TreeCommitContext.Provider value={value}>{children}</TreeCommitContext.Provider>;
}

interface TreeCommitLabel {
  author: string;
  tone?: "self" | "other";
  time?: string;
  detail: string;
}

export function useTreeCommitAuthor(path: string, status?: StatusLetter): TreeCommitLabel | undefined {
  const directories = useContext(TreeCommitContext);
  const { commitScope } = useContext(TreeSvnContext);
  const directory = directories.get(pathKey(dirName(path)));
  if (!directory) return undefined;
  const commit = directory.files?.get(pathKey(path));
  if (commit?.revision != null) {
    const author = commit.author || "未知";
    const account = commitScope?.host === commit.host ? commitScope.user : undefined;
    const tone = commit.author && account ? (commit.author === account ? "self" : "other") : undefined;
    const time = commit.date && commit.date > 0 ? formatRevTime(commit.date) : undefined;
    const detail = ["最后提交人 " + author, "r" + commit.revision, time && "提交时间 " + time].filter(Boolean).join(" · ");
    return { author, tone, time, detail };
  }
  if (commit || status === "A") return { author: "未提交", detail: "文件尚未提交到 SVN" };
  if (status === "?") return { author: "未纳管", detail: "文件尚未加入 SVN" };
  if (directory.failed) return { author: "读取失败", detail: "提交信息读取失败，可通过资源树底部刷新重试" };
  if (directory.files && !status) return { author: "未纳管", detail: "文件尚未加入 SVN" };
  if (directory.files) return { author: "未知", detail: "工作副本没有提供此文件的最后提交信息" };
  return { author: "…", detail: "正在读取最后提交人" };
}
