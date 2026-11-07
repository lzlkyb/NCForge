import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { SettingsRow } from "../ui/SettingsRow";
import { SettingsChoice } from "../ui/SettingsChoice";
import { ToggleRow } from "../ui/ToggleRow";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { failureText } from "../../lib/friendlyError";
import { errorToast } from "../../lib/errorToast";
import { WorkerStatsRow } from "./WorkerStatsRow";
import {
  buildCacheInfo,
  buildHistory,
  type BuildCacheInfo,
  type BuildHistoryEntry,
} from "../../lib/compile";
import {
  getConfig,
  patchConfig,
  rememberAutoExternal,
  rememberAutoIncremental,
} from "../../lib/appConfig";
import { cleanTmpBuild, reindexBuild } from "../../lib/buildMaintenance";
import "./settings-development.css";

interface BuildCfg {
  auto_compile_incremental: boolean;
  auto_compile_external: boolean;
  prewarm_index: boolean;
  persistent_worker: boolean;
  build_parallel: number;
}

/**
 * 老配置 / 测试桩可能没有这几个键：缺省必须和默认值一致，
 * 否则界面显示「已关闭」而实际行为是开着的。
 */
const pick = (c: Partial<BuildCfg>): BuildCfg => ({
  auto_compile_incremental: c.auto_compile_incremental ?? true,
  auto_compile_external: c.auto_compile_external ?? true,
  prewarm_index: c.prewarm_index ?? true,
  persistent_worker: c.persistent_worker ?? true,
  build_parallel: c.build_parallel ?? 2,
});

/**
 * 设置 → 任务里的「构建」段：自动构建开关 + 缓存维护。
 *
 * 从 `TaskSettings` 抽出来：那边已经有一个开关和自定义任务表单，再塞四行开关与
 * 一张维护卡会顶破组件体量门禁；这两块也确实只和构建有关。
 */
export function BuildSettings() {
  const [cfg, setCfg] = useState<BuildCfg | null>(null);
  const [cache, setCache] = useState<BuildCacheInfo | null>(null);
  const [history, setHistory] = useState<BuildHistoryEntry[]>([]);
  const [confirmReindex, setConfirmReindex] = useState(false);
  const [working, setWorking] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  const loadStats = async () => {
    const [c, h] = await Promise.all([buildCacheInfo(), buildHistory()]);
    setCache(c);
    setHistory(h);
  };

  useEffect(() => {
    let alive = true;
    setLoadErr(null);
    // 读失败不再回落默认配置 / 静默吞掉统计错误：那会把「未知」显示成「已开启」、
    // 或让统计一直停在「—」却没有任何解释。统一记录错误并给重试入口。
    getConfig()
      .then((c) => alive && setCfg(pick(c)))
      .catch((e) => alive && setLoadErr(failureText("读取构建设置", e)));
    void loadStats().catch((e) => alive && setLoadErr(failureText("读取构建统计", e)));
    return () => {
      alive = false;
    };
  }, [retry]);

  const update = async (patch: Partial<BuildCfg>) => {
    const before = cfg;
    setCfg((prev) => (prev ? { ...prev, ...patch } : prev));
    if (patch.auto_compile_incremental !== undefined) rememberAutoIncremental(patch.auto_compile_incremental);
    if (patch.auto_compile_external !== undefined) rememberAutoExternal(patch.auto_compile_external);
    try {
      await patchConfig(patch);
    } catch (e) {
      setCfg(before);
      if (patch.auto_compile_incremental !== undefined) rememberAutoIncremental(!patch.auto_compile_incremental);
      if (patch.auto_compile_external !== undefined) rememberAutoExternal(!patch.auto_compile_external);
      errorToast("保存构建设置", e);
    }
  };

  const runReindex = async () => {
    setConfirmReindex(false);
    setWorking(true);
    try {
      await reindexBuild();
      await loadStats();
    } finally {
      setWorking(false);
    }
  };

  const runCleanTmp = async () => {
    setWorking(true);
    try {
      await cleanTmpBuild();
      await loadStats();
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      {loadErr && <div role="alert" className="flex items-center gap-2 px-2 py-1 text-xs text-destructive-ink">
        <span className="min-w-0 flex-1">{loadErr}</span>
        <Button size="sm" variant="ghost" onClick={() => setRetry((n) => n + 1)}>重试</Button>
      </div>}
      <ToggleRow
        id="build-auto-incremental"
        label="保存后补一次模块级增量"
        keywords={["编译", "增量", "模块", "incremental"]}
        sub="单文件反馈之后，空闲 2.5 秒再编受影响的模块"
        info="单文件编译发现不了「方法签名改了、引用方还在用旧签名」。第二阶段会按依赖方向重编受影响的模块，把这类错误补出来；连续保存只跑最后一次。"
        checked={cfg?.auto_compile_incremental ?? true}
        disabled={!cfg}
        valueText={!cfg ? "读取中" : cfg.auto_compile_incremental ? "已开启" : "已关闭"}
        onChange={(v) => void update({ auto_compile_incremental: v })}
      />
      <ToggleRow
        id="build-auto-external"
        label="外部修改 .java 也自动编译"
        keywords={["编译", "外部", "git", "svn", "监听"]}
        sub="git pull / 其他编辑器改完后自动进编译队列"
        info="只处理工作区内的 .java；本应用刚保存的文件会按时间窗挡掉，不会同一份改动编两次。一次事件里文件太多（例如切分支）时只提示，请手动「编译全部模块」。"
        checked={cfg?.auto_compile_external ?? true}
        disabled={!cfg}
        valueText={!cfg ? "读取中" : cfg.auto_compile_external ? "已开启" : "已关闭"}
        onChange={(v) => void update({ auto_compile_external: v })}
      />
      <ToggleRow
        id="build-prewarm"
        label="打开工程时预热类索引"
        keywords={["编译", "索引", "预热", "jar"]}
        sub="后台扫描 jar，首轮编译少等一会儿"
        info="预热只读磁盘上的 jar，不编源码、不启动 ecj。已经建过索引时这一步几乎瞬间完成；冷启动扫描几千个 jar 需要几十秒，放在后台做，不挡文件树。"
        checked={cfg?.prewarm_index ?? true}
        disabled={!cfg}
        valueText={!cfg ? "读取中" : cfg.prewarm_index ? "已开启" : "已关闭"}
        onChange={(v) => void update({ prewarm_index: v })}
      />
      <SettingsRow
        id="build-parallel"
        label="并行构建模块数"
        keywords={["构建", "并行", "性能", "模块"]}
        sub="相互独立的模块同时编；有依赖的仍按顺序"
        info="只在「编译全部模块」时生效：同一依赖层里互不依赖的模块最多同时起这么多个 ecj。调高会占更多内存，低配机器建议保持 1~2。"
        valueText={cfg ? `${cfg.build_parallel} 个` : "读取中"}
        control={
          <SettingsChoice
            label="并行构建模块数"
            value={String(cfg?.build_parallel ?? 2)}
            disabled={!cfg}
            options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: `${n}` }))}
            onChange={(v) => void update({ build_parallel: Number(v) })}
          />
        }
      />

      <ToggleRow
        id="build-persistent-worker"
        label="常驻 ecj 编译进程"
        keywords={["编译", "常驻", "worker", "jvm", "性能", "内存"]}
        sub="复用后台 JVM，保存后编译少等 0.6~0.9 秒"
        info="默认开启：编译跑在常驻 JVM 里，省掉每次启动进程的时间；空闲 5 分钟后只保留一个，占用有限。关闭后每次编译单独起进程，内存最低，也适合怀疑常驻进程异常时对照排查；两种方式编出来的结果完全相同。"
        checked={cfg?.persistent_worker ?? true}
        disabled={!cfg}
        valueText={!cfg ? "读取中" : cfg.persistent_worker ? "已开启" : "已关闭"}
        onChange={(v) => void update({ persistent_worker: v })}
      />
      <WorkerStatsRow worker={cache?.worker} persistent={cfg?.persistent_worker ?? true} />

      <div className="settings-build-caption">构建缓存</div>
      <SettingsRow
        id="build-cache"
        label="缓存占用"
        keywords={["构建", "缓存", "索引", "清单", "统计"]}
        sub={
          cache
            ? `${cache.indexFiles} 个索引文件 · ${cache.manifestModules} 份清单 · ${cache.trackedClasses} 个已跟踪 class`
            : "还没读到统计"
        }
        info="索引与清单都在本机配置目录，不写进工作区。删掉它们不会删源码；下次编译会重新计算。"
        valueText={cache ? formatBytes(cache.indexBytes + cache.manifestBytes + cache.tmpBytes) : "—"}
        control={
          <Button size="sm" variant="ghost" disabled={working} onClick={() => void loadStats().catch((e) => errorToast("刷新构建统计", e))}>
            刷新
          </Button>
        }
      />
      {cache && cache.untrackedClasses.length > 0 && (
        <SettingsRow
          id="build-untracked"
          label="未跟踪产物"
          keywords={["构建", "残留", "class", "清理"]}
          sub={`${cache.untrackedClasses.length} 个 class 在输出目录里但没有对应源文件，可能是旧编译残留`}
          info="只在有构建清单时才能可靠判断。这里的产物不会被自动删除；需要时用「清理并重编」重建该模块。"
          valueText="建议清理"
          danger
        />
      )}
      <SettingsRow
        id="build-last"
        label="最近构建"
        keywords={["构建", "历史", "上次"]}
        sub={history.length ? lastBuildText(history[history.length - 1]) : "还没有构建记录"}
        valueText={cache?.lastSuccessMs ? `上次成功 ${new Date(cache.lastSuccessMs).toLocaleString()}` : "—"}
        control={
          <Button size="sm" variant="ghost" disabled={working} isLoading={working} onClick={() => setConfirmReindex(true)}>
            重建类索引
          </Button>
        }
      />
      <details className="settings-task-builtins">
        <summary>最近构建记录 <span>{history.length} 条</span></summary>
        <ul className="px-3 pb-2 text-xs text-muted-foreground">
          {history.slice(-8).reverse().map((h, i) => (
            <li key={`${h.atMs}-${i}`} className="flex items-center justify-between gap-3 py-0.5">
              <span className="truncate">{h.module}</span>
              <span className="shrink-0">
                {statusText(h.status)} · {h.errorCount} 个错误 · {new Date(h.atMs).toLocaleTimeString()}
              </span>
            </li>
          ))}
        </ul>
      </details>
      <SettingsRow
        id="build-tmp"
        label="编译临时文件"
        keywords={["构建", "临时文件", "清理"]}
        sub={cache ? formatBytes(cache.tmpBytes) : "—"}
        info="只清理配置目录下 ecj 的参数文件与原子写残留，不碰工作区。崩溃后残留的参数文件不会影响正确性，只会占一点空间。"
        valueText={cache ? `${formatBytes(cache.tmpBytes)}` : "—"}
        last
        control={
          <Button size="sm" variant="ghost" disabled={working} isLoading={working} onClick={() => void runCleanTmp()}>
            清理
          </Button>
        }
      />

      <ConfirmDialog
        open={confirmReindex}
        title="重建类索引？"
        description="会删除类索引文件与全部构建清单（不删 class 产物）。下次编译要重新扫描全部 jar，首轮会明显变慢；只有在补全 / 跳转异常或怀疑索引过期时才需要。"
        confirmLabel="重建索引"
        onCancel={() => setConfirmReindex(false)}
        onConfirm={() => void runReindex()}
      />
    </>
  );
}

function formatBytes(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function statusText(status: string): string {
  if (status === "ok" || status === "success") return "成功";
  if (status === "failed") return "失败";
  if (status === "blocked") return "被阻断";
  if (status === "skipped") return "跳过";
  return status;
}

function lastBuildText(h: BuildHistoryEntry): string {
  return `${h.module} · ${statusText(h.status)} · ${h.errorCount} 个错误 · ${(h.durationMs / 1000).toFixed(1)}s`;
}
