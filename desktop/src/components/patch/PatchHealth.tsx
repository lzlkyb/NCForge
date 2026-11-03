import { useQuery, useQueryClient } from "@tanstack/react-query";
import { patchDefaults, type PatchDefaults } from "../../lib/patch";
import { svnStatus, type StatusResult } from "../../lib/svn";
import type { CompileResult } from "../../lib/compile";
import { setSession, useWorkspaceRoot, useWorkspaceSelector } from "../../lib/workspaceSession";
import { useDbSelector } from "../../lib/dbStore";

type Tone = "ok" | "warn" | "bad" | "busy" | "idle";

/**
 * 补丁页的环境健康条：编译器 / NC Home / SVN / 数据库。
 *
 * 出包失败时用户最常问的是「到底哪一环没准备好」。这四项散在四个页面里
 * （编译在底部面板、NC Home 在服务配置、SVN 在版本控制、数据库在连接页），
 * 出包本来就要等几十秒，来回翻页只会让人放弃核对。这里只**读**现有缓存与模块级
 * 状态，不额外发起 SVN 扫描——扫描本身就是这里最贵的一步，补丁页已经在扫了。
 */
export function PatchHealth() {
  const root = useWorkspaceRoot();
  const qc = useQueryClient();
  const compiling = useWorkspaceSelector((s) => s.compiling);
  const compiled = useWorkspaceSelector((s) => s.compileResult);
  const defaults = useQuery({
    queryKey: ["patch-defaults", root],
    queryFn: patchDefaults,
    staleTime: 30_000,
    retry: false,
  });
  const changes = useQuery({
    queryKey: ["patch-changes", root],
    queryFn: svnStatus,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const dbOn = useDbSelector((s) => s.conns.filter((c) => s.rt[c.id]?.status === "connected").length);
  const dbName = useDbSelector((s) => s.conns.find((c) => s.rt[c.id]?.status === "connected")?.name ?? "");

  const go = (tab: string) =>
    window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: tab }));

  const db: Chip =
    dbOn > 0
      ? { tone: "ok", text: `DB · ${dbName || `${dbOn} 个连接`}`, title: "点一下打开数据库页（表结构核对要用）" }
      : { tone: "warn", text: "DB · 未连接", title: "表结构核对需要数据库连接：点一下去连接" };

  return (
    <div className="pk-health" role="group" aria-label="出包环境">
      <ChipView
        chip={compileChip(compiling, compiled)}
        onClick={() => {
          setSession({ panelOpen: true, panelTab: "problems" });
          go("files");
        }}
      />
      <ChipView
        chip={homeChip(defaults.data, defaults.isError)}
        onClick={() => {
          if (defaults.isError) void defaults.refetch();
          go("services");
        }}
      />
      <ChipView
        chip={svnChip(changes.data, changes.isFetching, changes.isError)}
        onClick={() => {
          void qc.invalidateQueries({ queryKey: ["patch-changes"] });
          void qc.invalidateQueries({ queryKey: ["patch-scan"] });
        }}
      />
      <ChipView chip={db} onClick={() => go("db")} />
    </div>
  );
}

interface Chip {
  tone: Tone;
  text: string;
  title: string;
}

function ChipView({ chip, onClick }: { chip: Chip; onClick: () => void }) {
  return (
    <button
      type="button"
      className="pk-health-chip"
      data-tone={chip.tone}
      title={chip.title}
      onClick={onClick}
    >
      <span className="pk-health-dot" aria-hidden="true" />
      {chip.text}
    </button>
  );
}

function compileChip(compiling: boolean, r: CompileResult | null): Chip {
  if (compiling) return { tone: "busy", text: "编译器 · 编译中", title: "正在编译，结束后这里会变成结果" };
  if (!r) {
    return {
      tone: "idle",
      text: "编译器 · 未编译",
      title: "这次会话还没编译过：.class 可能比源码旧，点一下打开编译面板",
    };
  }
  if (r.errorCount > 0) {
    return {
      tone: "bad",
      text: `编译器 · ${r.errorCount} 错误`,
      title: `${r.errorCount} 个错误 / ${r.warningCount} 个警告 · 点一下打开问题面板`,
    };
  }
  if (r.warningCount > 0) {
    return { tone: "warn", text: `编译器 · ${r.warningCount} 警告`, title: "没有错误 · 点一下打开问题面板" };
  }
  return {
    tone: "ok",
    text: "编译器 · 通过",
    title: `编译通过 · ${r.sourceCount} 个源文件 · ${Math.round(r.durationMs)}ms`,
  };
}

function homeChip(d: PatchDefaults | undefined, failed: boolean): Chip {
  if (failed) {
    return {
      tone: "bad",
      text: "NC Home · 读不到",
      title: "读取补丁默认值失败：点一下重试，并到服务页核对 NC Home",
    };
  }
  if (!d) return { tone: "idle", text: "NC Home · 读取中", title: "正在读取补丁默认值" };
  if (!d.ncHome) {
    return {
      tone: "bad",
      text: "NC Home · 未配置",
      title: "没定位到 NC Home：hotwebs / 客户端类改动无法落位 · 点一下去服务页配置",
    };
  }
  if (d.ncHomeModules === 0) {
    return {
      tone: "warn",
      text: "NC Home · 0 模块",
      title: `${d.ncHome} 下一个模块都没数到，路径可能不对 · 点一下去服务页核对`,
    };
  }
  return {
    tone: "ok",
    text: `NC Home · ${d.ncHomeModules} 模块`,
    title: `${d.ncHome} · 点一下去服务页查看`,
  };
}

function svnChip(r: StatusResult | undefined, fetching: boolean, failed: boolean): Chip {
  if (failed) return { tone: "bad", text: "SVN · 扫描失败", title: "点一下重扫未提交改动" };
  if (fetching) return { tone: "busy", text: "SVN · 扫描中", title: "工作副本上万个条目，首次要几秒" };
  if (!r) return { tone: "idle", text: "SVN · 未扫描", title: "还没读到未提交改动" };
  const n = r.changes.groups.reduce(
    (sum, g) => sum + g.items.filter((it) => !it.ignored).length,
    0,
  );
  return {
    tone: n > 0 ? "ok" : "idle",
    text: `SVN · ${n} 改动`,
    title: `另有 ${r.changes.ignored} 条构建产物未计入 · 点一下重扫`,
  };
}
