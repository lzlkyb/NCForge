import { useState, useSyncExternalStore } from "react";
import { ToggleRow } from "../ui/ToggleRow";
import { SettingsGroup } from "./SettingsGroup";
import { getSqlUsageEnabled, setSqlUsageEnabled, subscribeSqlUsage } from "../../lib/sqlUsage";

export function SqlCompletionSettings() {
  const enabled = useSyncExternalStore(subscribeSqlUsage, getSqlUsageEnabled);
  const [failed, setFailed] = useState(false);
  return <SettingsGroup title="SQL 智能补全" summary={enabled ? "记住常用表与字段" : "按匹配顺序提示"} defaultOpen>
    <ToggleRow id="sql-assist-learning" label="根据使用习惯排序" sub="常用表与字段在同等匹配内靠前" checked={enabled} last
      keywords={["SQL", "补全", "智能", "记忆", "常用表", "提示"]} info="按连接和 schema 分开记忆，仅保存在本机。关闭后停止学习并恢复普通排序。可在数据库工具栏的「更多 → 补全记忆」中固定、忘记或清除记录。"
      error={failed ? "本次会话已生效，但未保存到本机。" : undefined} onChange={value => setFailed(!setSqlUsageEnabled(value))} onRetry={() => setFailed(!setSqlUsageEnabled(enabled))} />
  </SettingsGroup>;
}
