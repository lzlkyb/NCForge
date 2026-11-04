// 设置 → 外观：界面材质（玻璃 / 经典）与本机阅读密度。
//
// 材质独立于明暗主题，只切 <html data-ui-style>；偏好存 localStorage，不进
// AppConfig——「这台机器看着顺眼」不该跟着配置导入导出跑到同事机器上。
import { useCallback, useEffect, useState } from "react";
import { Card } from "../ui/card";
import { SettingsRow } from "../ui/SettingsRow";
import { SettingsChoice } from "../ui/SettingsChoice";
import { Button } from "../ui/button";
import { applyTheme, type Theme, type ThemeSaveResult } from "../../lib/theme";
import { AppearancePreview } from "./AppearancePreview";
import { applyUiDensity, getUiDensity, subscribeUiDensity, type UiDensity } from "../../lib/uiDensity";
import {
  applyAppearance,
  getAppearance,
  subscribeAppearance,
  type Appearance,
} from "../../lib/appearance";

export function AppearanceSettings() {
  // 初值读 DOM：main.tsx 已在 React 挂载前把存储值写进 dataset。
  const [appearance, setAppearance] = useState<Appearance>(getAppearance);
  const [density, setDensity] = useState<UiDensity>(getUiDensity);
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.classList.contains("dark") ? "dark" : "light");
  const [feedback, setFeedback] = useState<Partial<Record<"主题" | "材质" | "密度", { saved: boolean; error?: string }>>>({});
  const report = useCallback((stored: boolean, label: "主题" | "材质" | "密度") => {
    setFeedback(prev => ({ ...prev, [label]: { saved: stored,
      error: stored ? undefined : `${label}已在本次会话生效，但无法保存到本机，重启后会恢复原值。`,
    } }));
  }, []);

  useEffect(() => subscribeAppearance(() => setAppearance(getAppearance())), []);
  useEffect(() => subscribeUiDensity(() => setDensity(getUiDensity())), []);
  useEffect(() => {
    const sync = () => setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    const saved = (event: Event) => report((event as CustomEvent<ThemeSaveResult>).detail.stored, "主题");
    window.addEventListener("themechange", sync);
    window.addEventListener("themesave", saved);
    return () => { window.removeEventListener("themechange", sync); window.removeEventListener("themesave", saved); };
  }, [report]);

  const change = (next: Appearance) => {
    setAppearance(next);
    // 存储不可用时本次切换仍生效，但重启后会回到默认——必须说出来。
    report(applyAppearance(next), "材质");
  };

  return (
    <Card className="flex flex-col gap-1 p-2">
      <AppearancePreview theme={theme} density={density} appearance={appearance} />
      <SettingsRow id="appearance-theme" label="明暗主题" valueText={theme === "dark" ? "深色" : "浅色"}
        {...feedback.主题}
        keywords={["主题", "theme", "深色", "浅色", "明暗"]}
        sub="与标题栏主题切换同步，立即生效"
        control={<div className="flex flex-wrap items-center gap-2"><SettingsChoice label="明暗主题" value={theme}
          options={[{ value: "light", label: "浅色" }, { value: "dark", label: "深色" }]}
          onChange={value => applyTheme(value as Theme)} />
          {feedback.主题?.error && <Button variant="ghost" size="sm" onClick={() => applyTheme(theme)}>重试保存</Button>}
        </div>} />
      <SettingsRow
        id="appearance-material" keywords={["材质", "毛玻璃", "柔光", "经典", "material"]}
        valueText={appearance === "glass" ? "柔光玻璃" : "经典"}
        {...feedback.材质}
        label="界面材质"
        sub="柔光玻璃 提供半透明层次；经典 使用实色背景"
        info="柔光玻璃使用窗口内的柔和彩色背景，标题栏与侧栏共享材质；代码、数据库表格与日志保持清晰的阅读底色。偏好只存本机，不随配置迁移。"
        control={
          <div className="flex flex-wrap items-center gap-2"><SettingsChoice
            label="界面材质"
            value={appearance}
            options={[
              { value: "glass", label: "柔光玻璃" },
              { value: "classic", label: "经典" },
            ]}
            onChange={(v) => change(v as Appearance)}
          />{feedback.材质?.error && <Button variant="ghost" size="sm" onClick={() => change(appearance)}>重试保存</Button>}</div>
        }
      />
      <SettingsRow
        id="appearance-density" keywords={["密度", "舒适", "标准", "density"]}
        valueText={density === "comfortable" ? "舒适" : "标准"}
        {...feedback.密度}
        label="界面密度"
        sub="标准 保留紧凑布局；舒适 增大界面文字与常用控件"
        info="只调整界面阅读与操作空间，代码字号仍在编辑器设置中调整。偏好保存在本机。"
        control={<div className="flex flex-wrap items-center gap-2"><SettingsChoice label="界面密度" value={density}
          options={[{ value: "standard", label: "标准" }, { value: "comfortable", label: "舒适" }]}
          onChange={(value) => {
            report(applyUiDensity(value as UiDensity), "密度");
          }} />{feedback.密度?.error && <Button variant="ghost" size="sm" onClick={() => report(applyUiDensity(density), "密度")}>重试保存</Button>}</div>}
        last
      />
    </Card>
  );
}
