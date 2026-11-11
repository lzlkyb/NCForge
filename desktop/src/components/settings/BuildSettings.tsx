import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { SettingsRow } from "../ui/SettingsRow";
import { SettingsChoice } from "../ui/SettingsChoice";
import { ToggleRow } from "../ui/ToggleRow";
import { SettingsGroup } from "./SettingsGroup";
import { BuildCacheSettings } from "./BuildCacheSettings";
import { failureText } from "../../lib/friendlyError";
import { useSettingsMutation } from "../../hooks/useSettingsMutation";
import { getConfig, patchConfig, rememberAutoExternal, rememberAutoIncremental } from "../../lib/appConfig";
import "./settings-development.css";

interface BuildCfg { auto_compile_incremental: boolean; auto_compile_external: boolean; prewarm_index: boolean; persistent_worker: boolean; build_parallel: number }
const pick = (c: Partial<BuildCfg>): BuildCfg => ({
  auto_compile_incremental: c.auto_compile_incremental ?? true, auto_compile_external: c.auto_compile_external ?? true,
  prewarm_index: c.prewarm_index ?? true, persistent_worker: c.persistent_worker ?? true, build_parallel: c.build_parallel ?? 2,
});

export function BuildSettings() {
  const [cfg, setCfg] = useState<BuildCfg | null>(null);
  const [loadErr, setLoadErr] = useState<string>();
  const [reload, setReload] = useState(0);
  const mutation = useSettingsMutation();
  useEffect(() => {
    let alive = true;
    getConfig().then(c => { if (alive) { setCfg(pick(c)); setLoadErr(undefined); } },
      e => { if (alive) setLoadErr(failureText("读取构建设置", e)); });
    return () => { alive = false; };
  }, [reload]);
  const update = (patch: Partial<BuildCfg>) => {
    const key = Object.keys(patch)[0];
    void mutation.run(key, async () => {
      const next = await patchConfig(patch);
      setCfg(pick(next));
      if (patch.auto_compile_incremental !== undefined) rememberAutoIncremental(patch.auto_compile_incremental);
      if (patch.auto_compile_external !== undefined) rememberAutoExternal(patch.auto_compile_external);
    });
  };
  return <>
    {loadErr && <p role="alert" className="settings-inline-error">{loadErr}<Button size="sm" variant="ghost" onClick={() => setReload(n => n + 1)}>重新读取</Button></p>}
    <ToggleRow id="build-auto-incremental" label="保存后检查受影响的模块"
      keywords={["编译", "增量", "模块", "incremental"]} sub="单文件反馈之后，空闲 2.5 秒再编译受影响的模块。"
      info="补充检查方法签名或继承关系变化后，引用方是否仍然正确。连续保存只运行最后一次。"
      checked={cfg?.auto_compile_incremental ?? true} disabled={!cfg}
      valueText={!cfg ? "读取中" : cfg.auto_compile_incremental ? "已开启" : "已关闭"}
      onChange={v => update({ auto_compile_incremental: v })} {...mutation.feedback("auto_compile_incremental")} />
    <ToggleRow id="build-auto-external" label="外部修改 Java 文件时自动编译"
      keywords={["编译", "外部", "git", "svn", "监听"]} sub="Git、SVN 或其他编辑器修改后，加入编译队列。"
      info="只处理工作区内的 Java 文件。批量变化过多时提示手动编译，避免重复构建。"
      checked={cfg?.auto_compile_external ?? true} disabled={!cfg}
      valueText={!cfg ? "读取中" : cfg.auto_compile_external ? "已开启" : "已关闭"}
      onChange={v => update({ auto_compile_external: v })} {...mutation.feedback("auto_compile_external")} />
    <SettingsGroup title="构建性能" summary={cfg ? `并行 ${cfg.build_parallel} · 常驻编译进程${cfg.persistent_worker ? "开启" : "关闭"}` : "正在读取"} defaultOpen>
      <SettingsRow id="build-parallel" label="并行构建模块数" keywords={["构建", "并行", "性能", "模块"]}
        sub="仅影响编译全部模块。内存较少时建议 1–2，有依赖的模块仍按顺序构建。"
        valueText={cfg ? `${cfg.build_parallel} 个` : "读取中"} {...mutation.feedback("build_parallel")}
        control={<SettingsChoice label="并行构建模块数" value={String(cfg?.build_parallel ?? 2)}
          disabled={!cfg || mutation.feedback("build_parallel").pending} options={[1, 2, 3, 4].map(n => ({ value: String(n), label: String(n) }))}
          onChange={v => update({ build_parallel: Number(v) })} />} />
      <ToggleRow id="build-persistent-worker" label="保留后台编译进程" keywords={["编译", "常驻", "worker", "ecj", "JVM", "性能"]}
        sub="复用 JVM 缩短编译等待；关闭后每次单独启动进程，内存占用更低。"
        checked={cfg?.persistent_worker ?? true} disabled={!cfg}
        onChange={v => update({ persistent_worker: v })} {...mutation.feedback("persistent_worker")} />
      <ToggleRow id="build-prewarm" label="打开工程时预热类索引" keywords={["编译", "索引", "预热", "jar"]}
        sub="下次打开工程时后台扫描 jar，减少首次编译等待。"
        checked={cfg?.prewarm_index ?? true} disabled={!cfg} last
        onChange={v => update({ prewarm_index: v })} {...mutation.feedback("prewarm_index")} />
    </SettingsGroup>
    <BuildCacheSettings persistent={cfg?.persistent_worker ?? true} />
  </>;
}
