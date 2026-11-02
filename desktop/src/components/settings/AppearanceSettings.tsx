// 设置 → 外观：界面材质（玻璃 / 经典）。
//
// 材质独立于明暗主题，只切 <html data-ui-style>；偏好存 localStorage，不进
// AppConfig——「这台机器看着顺眼」不该跟着配置导入导出跑到同事机器上。
import { useEffect, useState } from "react";
import { Card } from "../ui/card";
import { SettingsRow } from "../ui/SettingsRow";
import { SettingsChoice } from "../ui/SettingsChoice";
import { toast } from "../ui/toast";
import {
  applyAppearance,
  getAppearance,
  subscribeAppearance,
  type Appearance,
} from "../../lib/appearance";

export function AppearanceSettings() {
  // 初值读 DOM：main.tsx 已在 React 挂载前把存储值写进 dataset。
  const [appearance, setAppearance] = useState<Appearance>(getAppearance);

  useEffect(() => subscribeAppearance(() => setAppearance(getAppearance())), []);

  const change = (next: Appearance) => {
    setAppearance(next);
    // 存储不可用时本次切换仍生效，但重启后会回到默认——必须说出来。
    if (!applyAppearance(next)) {
      toast("材质已切换，但存储不可用，重启后会恢复默认", "warning");
    }
  };

  return (
    <Card className="flex flex-col gap-1 p-2">
      <SettingsRow
        label="界面材质"
        sub="玻璃 带半透明层次；经典 更朴素"
        info="只影响界面本身的表面材质，明暗主题与终端配色各管各的。偏好只存本机，不随配置迁移。"
        control={
          <SettingsChoice
            label="界面材质"
            value={appearance}
            options={[
              { value: "glass", label: "玻璃" },
              { value: "classic", label: "经典" },
            ]}
            onChange={(v) => change(v as Appearance)}
          />
        }
        last
      />
    </Card>
  );
}
