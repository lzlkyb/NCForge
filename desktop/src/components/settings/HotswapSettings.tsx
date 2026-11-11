import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button";
import { SettingsRow } from "../ui/SettingsRow";
import { ToggleRow } from "../ui/ToggleRow";
import { failureText } from "../../lib/friendlyError";
import { errorToast } from "../../lib/errorToast";
import { getConfig, patchConfig } from "../../lib/appConfig";
import { useSettingsMutation } from "../../hooks/useSettingsMutation";
import { hotswapPushPending, hotswapStatus, refreshHotswapStatus, type HotswapStatus } from "../../lib/hotswap";
import "./settings-development.css";

interface HotswapCfg {
  hotswap_enabled: boolean;
  hotswap_auto: boolean;
}

/**
 * 设置 → 任务里的「热替换」段（设计稿 design/热替换界面设计稿-2026-11-09.html ④）。
 *
 * 没并进 `BuildSettings`：那边已接近组件体量门禁，而且这一段还要读运行中服务的状态。
 * 老配置没有这两个键时按默认值（开）显示，与后端 serde 默认一致。
 */
export function HotswapSettings() {
  const [cfg, setCfg] = useState<HotswapCfg | null>(null);
  const [live, setLive] = useState<HotswapStatus | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [retry, setRetry] = useState(0);
  const mutation = useSettingsMutation();

  const loadLive = useCallback(() => hotswapStatus().then(setLive, () => setLive(null)), []);

  useEffect(() => {
    let alive = true;
    setLoadErr(null);
    getConfig()
      .then((c) => alive && setCfg({ hotswap_enabled: c.hotswap_enabled ?? true, hotswap_auto: c.hotswap_auto ?? true }))
      .catch((e) => alive && setLoadErr(failureText("读取热替换设置", e)));
    void loadLive();
    return () => {
      alive = false;
    };
  }, [retry, loadLive]);

  const update = async (patch: Partial<HotswapCfg>) => {
    await mutation.run(Object.keys(patch)[0], async () => {
      const next = await patchConfig(patch);
      setCfg({ hotswap_enabled: next.hotswap_enabled, hotswap_auto: next.hotswap_auto });
      void loadLive();
      refreshHotswapStatus();
    });
  };

  const push = async () => {
    setPushing(true);
    try {
      await hotswapPushPending();
    } catch (e) {
      errorToast("热替换推送", e);
    } finally {
      setPushing(false);
      void loadLive();
    }
  };

  const on = cfg?.hotswap_enabled ?? true;
  return (
    <>
      <div className="settings-build-caption">热替换</div>
      {loadErr && <div role="alert" className="flex items-center gap-2 px-2 py-1 text-xs text-destructive-ink">
        <span className="min-w-0 flex-1">{loadErr}</span>
        <Button size="sm" variant="ghost" onClick={() => setRetry((n) => n + 1)}>重试</Button>
      </div>}
      <ToggleRow
        id="build-hotswap"
        label="保存后热替换到运行中的服务"
        keywords={["热替换", "hotswap", "redefine", "agent", "不重启", "生效"]}
        sub="总开关在下次启动 NC 服务时生效。当前服务是否可用，见下方状态。"
        info="只对工作台启动、并带上 agent 的中间件生效；开关在下次启动服务时生效（agent 是启动参数）。JVM 只允许改方法体：新增/删除方法、字段或改了签名时会失败，需要重启服务。工程 classes 在 classpath 里排在同名 jar 后面时，该类会报「被遮挡」。"
        checked={on}
        disabled={!cfg}
        valueText={!cfg ? "读取中" : on ? "已开启" : "已关闭"}
        onChange={(v) => void update({ hotswap_enabled: v })}
        {...mutation.feedback("hotswap_enabled")}
      />
      <ToggleRow
        id="build-hotswap-auto"
        label="编译完自动推送"
        keywords={["热替换", "推送", "手动", "自动"]}
        sub="关闭后攒着，由你点「推送」"
        info="关闭后编译通过的类先攒着，状态栏显示「待推送 N」，点一下再推。适合一次改多个文件、不想让服务看到中间状态的场景。服务重启后待推列表作废（新 JVM 加载的就是磁盘上的新代码）。"
        checked={cfg?.hotswap_auto ?? true}
        disabled={!cfg || !on}
        disabledReason={!on ? "先打开「保存后热替换」" : undefined}
        valueText={!cfg ? "读取中" : cfg.hotswap_auto ? "已开启" : "已关闭"}
        onChange={(v) => void update({ hotswap_auto: v })}
        {...mutation.feedback("hotswap_auto")}
      />
      <SettingsRow
        id="build-hotswap-live"
        label="当前服务"
        keywords={["热替换", "推送", "agent", "状态"]}
        sub={`${liveText(live)}${!on ? "；请先开启热替换" : live?.pending === 0 ? "；当前没有待推送的类" : live && !live.agentOnline ? "；代理就绪后可推送" : ""}`}
        valueText={!live ? "状态未知" : live.agentOnline ? "agent 已就绪" : live.agentAttached ? "agent 准备中" : "未挂载"}
        last
        control={
          <div className="settings-form-actions"><Button size="sm" variant="ghost" onClick={() => void loadLive()}>重新读取状态</Button>
          <Button size="sm" variant="ghost" disabled={!on || !live?.agentOnline || !live.pending || pushing} isLoading={pushing} onClick={() => void push()}>
            立即推送
          </Button></div>
        }
      />
    </>
  );
}

function liveText(s: HotswapStatus | null): string {
  if (!s) return "状态未知，请重新读取";
  if (!s.agentOnline) return s.agentAttached ? "agent 准备中（NC 加载完 jar 后就绪）" : "服务未运行，或本次启动没带 agent";
  const parts = ["agent 已挂载"];
  if (s.last) parts.push(`上次 ${new Date(s.last.atMs).toLocaleTimeString()} ${s.last.state === "failed" ? "失败" : `替换 ${s.last.redefined.length} 个类`}`);
  if (s.pending) parts.push(`待推送 ${s.pending} 个`);
  return parts.join(" · ");
}
