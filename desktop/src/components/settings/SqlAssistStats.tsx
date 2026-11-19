import { useState, useSyncExternalStore } from "react";
import { ToggleRow } from "../ui/ToggleRow";
import { SettingsGroup } from "./SettingsGroup";
import {
  assistStatsSnapshot,
  clearAssistStats,
  setAssistStatsEnabled,
  subscribeAssistStats,
  summarizeAssistStats,
  type AssistSource,
} from "../../lib/sqlAssistStats";

/** 建议源的界面名。与 `ASSIST_SOURCES` 一一对应，缺了会显示原始键。 */
const SOURCE_LABELS: Record<AssistSource, string> = {
  table: "表名", column: "字段", predicate: "运算符条件", time: "时间快捷",
  template: "查询模板", billjoin: "主子表联查", join: "业务关系 JOIN", joinhistory: "历史 JOIN",
  condition: "常用条件", enum: "枚举值", related: "相关查询", archive: "档案展开",
  snippet: "SQL 片段", function: "函数", keyword: "关键字", alias: "别名",
  projection: "SELECT 输出", cte: "CTE", derived: "查询输出列", action: "位置动作",
};
const percent = (value: number) => `${Math.round(value * 100)}%`;

/**
 * 补全质量统计（先有数，再谈剪枝）。
 *
 * 只读本机计数：各建议源曝光/接受、元数据读取的预算达标率。不含 SQL 正文、
 * 不含对象名、不上传。带后续动作的条目（选字段、唤起菜单、位置动作）只计曝光——
 * 它们的 command 已被占用，接受信号拿不到，口径在这里明示而不是悄悄少算。
 */
export function SqlAssistStatsGroup() {
  const snapshot = useSyncExternalStore(subscribeAssistStats, assistStatsSnapshot);
  const [failed, setFailed] = useState(false);
  const { early, sources } = summarizeAssistStats(snapshot);
  const calls = snapshot.calls.auto + snapshot.calls.invoke;
  const summary = !snapshot.enabled ? "已关闭" : calls ? `${calls} 次补全 · ${sources.length} 类建议有曝光` : "还没有数据";
  return <SettingsGroup title="SQL 补全质量统计" summary={summary}>
    <ToggleRow id="sql-assist-stats" label="统计补全质量" sub="建议曝光/接受与超时计数，仅本机" checked={snapshot.enabled}
      keywords={["SQL", "补全", "统计", "质量", "接受率", "超时"]} info="记录每类建议端出来多少、被接受多少，以及字段/关系读取有没有超出时间预算。只存计数，不存 SQL 内容，不上传。关闭后立即停止记录。"
      error={failed ? "本次会话已生效，但未保存到本机。" : undefined} onChange={value => setFailed(!setAssistStatsEnabled(value))} onRetry={() => setFailed(!setAssistStatsEnabled(snapshot.enabled))} />
    {snapshot.enabled && calls > 0 && <div className="px-1 pb-2 text-xs text-muted-foreground">
      <div className="mb-1 flex items-center justify-between">
        <span>预算达标率（自动 {percent(early[0].okRate)} · {early[0].waits} 次等待 / {early[0].timeouts} 次超时；手动 {percent(early[1].okRate)} · {early[1].waits} / {early[1].timeouts}）</span>
        <button type="button" className="dbx-btn ghost" onClick={() => clearAssistStats()}>清空统计</button>
      </div>
      {sources.length > 0 && <table className="w-full border-collapse">
        <thead><tr className="text-left opacity-70"><th className="py-0.5 font-normal">建议源</th><th className="py-0.5 text-right font-normal">曝光</th><th className="py-0.5 text-right font-normal">接受</th><th className="py-0.5 text-right font-normal">接受率</th></tr></thead>
        <tbody>{sources.map(row => <tr key={row.source}>
          <td className="py-0.5">{SOURCE_LABELS[row.source] ?? row.source}</td>
          <td className="py-0.5 text-right tabular-nums">{row.offers}</td>
          <td className="py-0.5 text-right tabular-nums">{row.accepts}</td>
          <td className="py-0.5 text-right tabular-nums">{percent(row.rate)}</td>
        </tr>)}</tbody>
      </table>}
      <p className="mt-1 opacity-70">带后续动作的条目（选字段、唤起菜单、位置动作）只计曝光不计接受。接受率长期为零的建议源是降权或关闭的候选。</p>
    </div>}
  </SettingsGroup>;
}