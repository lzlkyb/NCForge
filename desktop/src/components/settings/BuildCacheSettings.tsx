import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { SettingsRow } from "../ui/SettingsRow";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { SettingsGroup } from "./SettingsGroup";
import { WorkerStatsRow } from "./WorkerStatsRow";
import { buildCacheInfo, buildHistory, type BuildCacheInfo, type BuildHistoryEntry } from "../../lib/compile";
import { askCleanTmp, reindexBuild } from "../../lib/buildMaintenance";
import { formatBytes } from "../../lib/utils";
import { failureText } from "../../lib/friendlyError";

export function BuildCacheSettings({ persistent }: { persistent: boolean }) {
  const [stats, setStats] = useState<{ cache: BuildCacheInfo; history: BuildHistoryEntry[] }>();
  const [state, setState] = useState<{ error?: string; busy: boolean; confirm: boolean }>({ busy: false, confirm: false });
  const load = async () => { const [cache, history] = await Promise.all([buildCacheInfo(), buildHistory()]); return { cache, history }; };
  useEffect(() => {
    let alive = true;
    load().then(next => { if (alive) setStats(next); }, e => { if (alive) setState({ busy: false, confirm: false, error: failureText("读取构建统计", e) }); });
    return () => { alive = false; };
  }, []);
  const lastAction = useRef<(() => Promise<unknown>) | undefined>(undefined);
  const run = async (action?: () => Promise<unknown>) => {
    // 记住最近一次动作（含纯刷新）：失败后的重试要重放它，而不是只重新拉统计。
    lastAction.current = action;
    setState({ busy: true, confirm: false });
    try {
      // `reindexBuild` / `cleanTmpBuild` 自己吞错误只弹 toast，靠返回值判成败：
      // 否则真失败了这里照样显示成功，错误条与「重试」永远不会出现。
      if (action && (await action()) === false) throw new Error("操作未完成，详情见刚才的提示");
    } catch (e) {
      setState({ busy: false, confirm: false, error: failureText("维护构建缓存", e) });
      return;
    }
    try {
      setStats(await load());
      setState({ busy: false, confirm: false });
    } catch (e) {
      // 动作已经做成，统计读不到不能报成「维护失败」。
      setState({ busy: false, confirm: false, error: failureText(action ? "已执行，但读取构建统计" : "读取构建统计", e) });
    }
  };
  const cache = stats?.cache;
  const history = stats?.history ?? [];
  return <SettingsGroup title="缓存与构建记录" summary={cache ? formatBytes(cache.indexBytes + cache.manifestBytes + cache.tmpBytes) : state.error ? "读取失败" : "正在读取"}>
    {state.error && <p className="settings-inline-error" role="alert">{state.error}<Button variant="ghost" size="sm" onClick={() => void run(lastAction.current)}>{lastAction.current ? "重试" : "重新读取"}</Button></p>}
    <WorkerStatsRow worker={cache?.worker} persistent={persistent} />
    <SettingsRow id="build-cache" label="类索引与构建缓存" keywords={["构建", "缓存", "索引", "清单", "统计", "重建"]}
      sub={cache ? `${cache.indexFiles} 个索引文件 · ${cache.manifestModules} 份清单 · ${cache.trackedClasses} 个已跟踪 class` : "正在读取统计"}
      valueText={cache ? formatBytes(cache.indexBytes + cache.manifestBytes + cache.tmpBytes) : "未知"}
      control={<div className="settings-form-actions"><Button size="sm" variant="ghost" disabled={state.busy} onClick={() => void run()}>刷新</Button>
        <Button size="sm" variant="outline" disabled={state.busy} onClick={() => setState(prev => ({ ...prev, confirm: true }))}>重建类索引</Button></div>} />
    <SettingsRow id="build-tmp" label="编译临时文件" keywords={["构建", "临时文件", "清理"]} valueText={cache ? formatBytes(cache.tmpBytes) : "未知"}
      sub="只清理配置目录下的编译参数文件与残留，不删除源码和工作区产物。"
      control={<Button size="sm" variant="outline" disabled={state.busy} isLoading={state.busy} onClick={() => void run(askCleanTmp)}>清理临时文件</Button>} />
    {!!cache?.untrackedClasses.length && <SettingsRow id="build-untracked" label="未跟踪产物" sub={`${cache.untrackedClasses.length} 个 class 可能是旧编译残留，可用模块的“清理并重编”处理。`} valueText="建议检查" />}
    <SettingsRow id="build-last" label="最近构建" keywords={["构建", "历史", "上次"]} last
      sub={history.length ? `${history[history.length - 1].module} · ${new Date(history[history.length - 1].atMs).toLocaleString()}` : "还没有构建记录"}
      valueText={history.length ? `${history[history.length - 1].errorCount} 个错误` : "无记录"} />
    {!!history.length && <ul className="settings-build-history">{history.slice(-8).reverse().map((entry, index) => <li key={index}>
      <span>{entry.module}</span><span>{["ok", "success"].includes(entry.status) ? "成功" : entry.status === "failed" ? "失败" : entry.status === "skipped" ? "跳过" : "被阻断"} · {entry.errorCount} 个错误 · {new Date(entry.atMs).toLocaleTimeString()}</span>
    </li>)}</ul>}
    <ConfirmDialog open={state.confirm} title="重建类索引？" description="删除类索引与构建清单，不删除 class 产物。下次编译会重新扫描 jar，首次构建会变慢。"
      confirmLabel="重建索引" onCancel={() => setState(prev => ({ ...prev, confirm: false }))} onConfirm={() => void run(reindexBuild)} />
  </SettingsGroup>;
}

