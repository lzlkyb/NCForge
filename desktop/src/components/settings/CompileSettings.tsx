import { BuildSettings } from "./BuildSettings";
import { HotswapSettings } from "./HotswapSettings";
import { ToggleRow } from "../ui/ToggleRow";
import { Button } from "../ui/button";
import { useAutoCompilePref } from "../../hooks/useAutoCompilePref";

export function CompileSettings() {
  const auto = useAutoCompilePref();
  return <>
    <h2>自动编译</h2>
    <ToggleRow id="task-auto-compile" label="保存时自动编译"
      keywords={["编译", "保存", "auto compile", "自动"]}
      sub="先编译刚保存的 Java 文件，再按下方选项补充模块级检查。"
      info="单文件编译提供即时反馈；修改签名或继承关系后，模块级增量检查负责检查引用方。"
      checked={auto.value ?? true} disabled={auto.value === null || auto.feedback.pending}
      disabledReason={auto.value === null ? "正在读取设置，读取成功后可调整" : undefined}
      {...auto.feedback}
      valueText={auto.value === null ? "读取中" : auto.value ? "已开启" : "已关闭"}
      onChange={v => void auto.save(v)} />
    {auto.error && <p role="alert" className="settings-inline-error">{auto.error}<Button size="sm" variant="ghost" onClick={auto.retry}>重试</Button></p>}
    <BuildSettings />
    <HotswapSettings />
  </>;
}
