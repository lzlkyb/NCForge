// 设置 → SQL 格式化：关键字大小写 / 缩进风格 / 宽度 / 语句间空行 / 方言。
//
// 全部落在 localStorage（`lib/sqlFormatPrefs`），不进 AppConfig：这是本机排版习惯，
// 跟着配置导入导出跑到同事机器上没有意义。改完立即生效（格式化每次调用都读最新值）。
import { useState } from "react";
import { Card } from "../ui/card";
import { SettingsRow } from "../ui/SettingsRow";
import { SettingsChoice } from "../ui/SettingsChoice";
import { SettingsField, integerRange } from "./SettingsField";
import { SettingsGroup } from "./SettingsGroup";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { SqlFormatPreview } from "./SqlFormatPreview";
import { SqlCompletionSettings } from "./SqlCompletionSettings";
import {
  SQL_DIALECTS, setSqlFormatPrefs, useSqlFormatPrefs, DEFAULT_SQL_FORMAT,
  type SqlDialect, type SqlFormatPrefs,
} from "../../lib/sqlFormatPrefs";

const CASE_LABEL = { preserve: "保持原样", upper: "大写", lower: "小写" } as const;
const INDENT_LABEL = { standard: "标准", tabularLeft: "表格·左对齐", tabularRight: "表格·右对齐" } as const;
const LOGICAL_LABEL = { before: "运算符在行首", after: "运算符在行尾" } as const;
const LAYOUT_LABEL = { reading: "阅读优先", expanded: "结构展开" } as const;

export function SqlFormatSettings() {
  const p = useSqlFormatPrefs();
  const [failed, setFailed] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const save = (patch: Partial<SqlFormatPrefs>) => {
    const stored = setSqlFormatPrefs(patch);
    setFailed(!stored);
    // Fields only report success when persistence succeeded, including same-value retries.
    if (!stored) throw new Error("本次会话已生效，但未保存到本机。请重试保存。");
  };
  const apply = (patch: Partial<SqlFormatPrefs>) => { try { save(patch); } catch { setFailed(true); } };
  const dialectLabel = SQL_DIALECTS.find((item) => item.value === p.dialect)?.label ?? p.dialect;
  return <Card className="flex flex-col gap-1 p-2">
    {failed && <p className="settings-row-feedback text-xs text-destructive-ink" role="alert">
      本次会话已生效，但无法写入本机存储；重启后可能恢复原值。
      <Button size="sm" variant="ghost" onClick={() => apply({})}>重试保存</Button>
    </p>}
    <SettingsGroup
      title="排版"
      defaultOpen
      summary={`${LAYOUT_LABEL[p.layout]}${p.layout === "reading" ? ` · ${p.lineWidth} 字符` : ""} · ${CASE_LABEL[p.keywordCase]} · ${p.tabWidth} 空格`}
    >
      <SettingsRow
        id="sql-format-layout" keywords={["SQL", "排版方式", "阅读优先", "结构展开", "紧凑", "换行太多"]}
        valueText={LAYOUT_LABEL[p.layout]} label="排版方式" sub="阅读优先减少零散换行，结构展开逐项展示"
        control={<SettingsChoice label="SQL 排版方式" value={p.layout}
          options={(Object.keys(LAYOUT_LABEL) as SqlFormatPrefs["layout"][]).map(value => ({ value, label: LAYOUT_LABEL[value] }))}
          onChange={value => apply({ layout: value as SqlFormatPrefs["layout"] })} />}
      />
      <SettingsRow
        id="sql-format-line-width" keywords={["SQL", "目标行宽", "字段列表", "阅读", "换行", "line width"]}
        valueText={`${p.lineWidth} 字符`} label="目标行宽" sub="字段按宽度填行，超长字符串保持完整"
        control={<SettingsField value={p.lineWidth} type="number" min={60} max={240} unit="字符"
          ariaLabel="SQL 目标行宽" validate={integerRange(60, 240, "字符")}
          disabled={p.layout !== "reading"} disabledReason={p.layout !== "reading" ? "切换到阅读优先后可调整" : undefined}
          onSave={value => save({ lineWidth: Number(value) })} />}
      />
      <SettingsRow
        id="sql-format-case" keywords={["SQL", "关键字大小写", "大写", "小写", "keyword case"]}
        valueText={CASE_LABEL[p.keywordCase]} label="关键字大小写" sub="默认保持原样，避免无意义的 diff"
        control={<SettingsChoice label="关键字大小写" value={p.keywordCase}
          options={(Object.keys(CASE_LABEL) as SqlFormatPrefs["keywordCase"][]).map((value) => ({ value, label: CASE_LABEL[value] }))}
          onChange={(value) => apply({ keywordCase: value as SqlFormatPrefs["keywordCase"] })} />}
      />
      <SettingsRow
        id="sql-format-indent" keywords={["SQL", "缩进风格", "标准", "表格", "indent"]}
        valueText={p.layout === "reading" ? "标准" : INDENT_LABEL[p.indentStyle]} label="缩进风格"
        sub={p.layout === "reading" ? "阅读优先使用标准缩进；表格对齐可选结构展开" : "表格风格把 SELECT 列竖向对齐"}
        control={<SettingsChoice label="缩进风格" value={p.layout === "reading" ? "standard" : p.indentStyle} disabled={p.layout === "reading"}
          options={(Object.keys(INDENT_LABEL) as SqlFormatPrefs["indentStyle"][]).map((value) => ({ value, label: INDENT_LABEL[value] }))}
          onChange={(value) => apply({ indentStyle: value as SqlFormatPrefs["indentStyle"] })} />}
      />
      <SettingsRow
        id="sql-format-tab" keywords={["SQL", "缩进宽度", "Tab", "indent width"]}
        valueText={`${p.tabWidth} 空格`} label="缩进宽度" sub="每级缩进用几个空格"
        control={<SettingsField value={p.tabWidth} type="number" min={1} max={8} unit="空格"
          ariaLabel="SQL 缩进宽度" validate={integerRange(1, 8, "空格")}
          onSave={(value) => save({ tabWidth: Number(value) })} />}
      />
      <SettingsRow
        id="sql-format-logical" keywords={["SQL", "AND", "OR", "逻辑运算符", "换行"]}
        valueText={LOGICAL_LABEL[p.logicalOperatorNewline]} label="逻辑运算符换行" sub="WHERE 里 AND / OR 断行时运算符放哪一侧"
        last
        control={<SettingsChoice label="逻辑运算符换行" value={p.logicalOperatorNewline}
          options={(Object.keys(LOGICAL_LABEL) as SqlFormatPrefs["logicalOperatorNewline"][]).map((value) => ({ value, label: LOGICAL_LABEL[value] }))}
          onChange={(value) => apply({ logicalOperatorNewline: value as SqlFormatPrefs["logicalOperatorNewline"] })} />}
      />
    </SettingsGroup>

    <SettingsGroup
      title="宽度与方言"
      summary={`${dialectLabel} · 括号内表达式 ${p.expressionWidth} 字符 · 语句间 ${p.linesBetweenQueries} 空行`}
    >
      <SettingsRow
        id="sql-format-dialect" keywords={["SQL", "方言", "Oracle", "MySQL", "PostgreSQL", "SQL Server", "DB2", "SQLite", "dialect"]}
        valueText={dialectLabel} label="方言" sub="手动指定会覆盖按连接自动推断"
        control={<select className="settings-select" aria-label="SQL 方言" value={p.dialect}
          onChange={e => apply({ dialect: e.target.value as SqlDialect })}>
          {SQL_DIALECTS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>}
      />
      <SettingsRow
        id="sql-format-width" keywords={["SQL", "长表达式", "括号", "结构展开", "expression width"]}
        valueText={`${p.expressionWidth} 字符`} label="括号内表达式宽度" sub="结构展开时控制函数、IN 等括号内表达式"
        control={<SettingsField value={p.expressionWidth} type="number" min={1} max={200} unit="字符"
          ariaLabel="括号内表达式宽度" validate={integerRange(1, 200, "字符")}
          disabled={p.layout === "reading"} disabledReason={p.layout === "reading" ? "阅读优先按目标行宽收拢表达式" : undefined}
          onSave={(value) => save({ expressionWidth: Number(value) })} />}
      />
      <SettingsRow
        id="sql-format-lines" keywords={["SQL", "语句之间", "空行", "lines between queries"]}
        valueText={`${p.linesBetweenQueries} 行`} label="语句之间空行" sub="相邻语句之间保留几行空白"
        last
        control={<SettingsField value={p.linesBetweenQueries} type="number" min={0} max={5} unit="行"
          ariaLabel="语句之间空行" validate={integerRange(0, 5, "行")}
          onSave={(value) => save({ linesBetweenQueries: Number(value) })} />}
      />
    </SettingsGroup>
    <SqlFormatPreview prefs={p} />
    <SqlCompletionSettings />
    <div className="settings-form-actions"><Button size="sm" variant="ghost" onClick={() => setResetOpen(true)}>恢复 SQL 排版默认值</Button></div>
    <ConfirmDialog open={resetOpen} title="恢复 SQL 排版默认值？" description="排版方式、目标行宽、关键字大小写、缩进、逻辑运算符换行、方言、括号内表达式宽度与语句间空行都会恢复默认，并立即生效。"
      confirmLabel="恢复默认" onCancel={() => setResetOpen(false)} onConfirm={() => { apply(DEFAULT_SQL_FORMAT); setResetOpen(false); }} />
  </Card>;
}
