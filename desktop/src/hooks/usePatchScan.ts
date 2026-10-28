import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { svnStatus, type ChangeItem } from "../lib/svn";
import { patchDefaults, patchScan } from "../lib/patch";

/**
 * 补丁页的数据源：SVN 改动 → 补丁清单。
 *
 * 两步是必须分开的（不是可以合并的一次调用）：第一步只拿「有哪些未提交文件」，
 * 第二步才让后端去探产物根、查 hyext jar、比对 .java/.class 时间。
 * 第二步很贵（首次要建 jar 索引），所以它的 `enabled` 挂在「有候选文件」上——
 * 没有改动的工作副本不该付这笔钱。
 */
export function usePatchScan() {
  const qc = useQueryClient();

  const defaults = useQuery({
    queryKey: ["patch-defaults"],
    queryFn: patchDefaults,
    staleTime: 30_000,
    retry: false,
  });

  const changes = useQuery({
    queryKey: ["patch-changes"],
    queryFn: svnStatus,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const all = useMemo(
    () => changes.data?.changes.groups.flatMap((g) => g.items).filter((it) => !it.isDir) ?? [],
    [changes.data],
  );

  // 已删除的文件打不进包（脚本里 D 状态直接跳过），单独一组展示，
  // 免得用户以为「我明明改了它，怎么没进包」。
  const deleted = useMemo(() => all.filter((it) => it.letter === "D"), [all]);

  // 构建产物不参与打包（`ignored` 是后端按 .class/.jar/冲突残留判的）
  const candidates = useMemo(
    () => all.filter((it) => it.letter !== "D" && !it.ignored),
    [all],
  );

  const paths = useMemo(() => candidates.map((it) => it.path), [candidates]);

  const scan = useQuery({
    queryKey: ["patch-scan", paths],
    queryFn: () => patchScan(paths, [], []),
    enabled: paths.length > 0,
    // 清单不缓存：class 的 mtime 随时会变（IDE 一编译），缓存只会给出
    // 「刚才还能打、现在不能打」的假结论。每次进页 / 点重扫都真扫。
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["patch-changes"] });
    void qc.invalidateQueries({ queryKey: ["patch-defaults"] });
    void qc.invalidateQueries({ queryKey: ["patch-scan"] });
  };

  return { defaults, changes, candidates, deleted, scan, refresh };
}

/** 候选文件的展示名：去掉模块前缀后的相对路径，列表里只放得下一行。 */
export function shortLabel(it: ChangeItem): string {
  const parts = it.rel.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : it.rel;
}
