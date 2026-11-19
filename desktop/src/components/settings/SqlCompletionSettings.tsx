import { useState, useSyncExternalStore } from "react";
import { ToggleRow } from "../ui/ToggleRow";
import { SettingsGroup } from "./SettingsGroup";
import { getSqlUsageEnabled, setSqlUsageEnabled, subscribeSqlUsage } from "../../lib/sqlUsage";
import {
  getSqlTemplatesEnabled,
  setSqlTemplatesEnabled,
  subscribeSqlTemplates,
} from "../../lib/sqlTemplates";
import { SqlAssistStatsGroup } from "./SqlAssistStats";

export function SqlCompletionSettings() {
  const enabled = useSyncExternalStore(subscribeSqlUsage, getSqlUsageEnabled);
  const templates = useSyncExternalStore(subscribeSqlTemplates, getSqlTemplatesEnabled);
  const [failed, setFailed] = useState(false);
  const [templateFailed, setTemplateFailed] = useState(false);
  return <>
    <SettingsGroup title="SQL 智能补全" summary={enabled ? "记住常用表与字段" : "按匹配顺序提示"} defaultOpen>
    <ToggleRow id="sql-assist-learning" label="根据使用习惯排序" sub="常用表与字段在同等匹配内靠前" checked={enabled}
      keywords={["SQL", "补全", "智能", "记忆", "常用表", "提示"]} info="按连接和 schema 分开记忆，仅保存在本机。关闭后停止学习并恢复普通排序。可在数据库工具栏的「更多 → 补全记忆」中固定、忘记或清除记录。"
      error={failed ? "本次会话已生效，但未保存到本机。" : undefined} onChange={value => setFailed(!setSqlUsageEnabled(value))} onRetry={() => setFailed(!setSqlUsageEnabled(enabled))} />
    <ToggleRow id="sql-assist-template" label="查询与条件模板" sub="输入表名生成查询，选择条件字段后直接填写值" checked={templates} last
      keywords={["SQL", "补全", "模板", "查询", "字段", "条件", "自动生成", "SELECT"]} info="输入表名或 NC 中文名可选择单表、关联查询和单号快捷模板。在 WHERE 或 ON 的新条件位置选择字段，可按字段类型补出等号和填写位置；精确输入字段名或在字段后按空格，可选择其他运算符。关闭后保留普通表名和字段补全。"
      error={templateFailed ? "本次会话已生效，但未保存到本机。" : undefined} onChange={value => setTemplateFailed(!setSqlTemplatesEnabled(value))} onRetry={() => setTemplateFailed(!setSqlTemplatesEnabled(templates))} />
    </SettingsGroup>
    <SqlAssistStatsGroup />
  </>;
}
