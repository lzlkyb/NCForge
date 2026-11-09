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
import {
  SQL_DIALECTS, setSqlFormatPrefs, useSqlFormatPrefs,
  type SqlDialect, type SqlFormatPrefs,
} from "../../lib/sqlFormatPrefs";

const CASE_LABEL = { preserve: "保持原样", upper: "大写", lower: "小写" } as const;
const INDENT_LABEL = { standard: "标准", tabularLeft: "表格·左对齐", tabularRight: "表格·右对齐" } as const;
const LOGICAL_LABEL = { before: "运算符在行首", after: "运算符在行尾" } as const;

export function SqlFormatSettings() {
  const p = useSqlFormatPrefs();
  const [failed, setFailed] = useState(false);
  const save = (patch: Partial<SqlFormatPrefs>) => setFailed(!setSqlFormatPrefs(patch));
  const dialectLabel = SQL_DIALECTS.find((item) => item.value === p.dialect)?.label ?? p.dialect;
  return <Card className="flex flex-col gap-1 p-2">
    {failed && <p className="settings-row-feedback text-xs text-destructive-ink" role="alert">
      已在本机生效，但无法写入本机存储；重启后可能恢复默认。
    </p>}
    <SettingsGroup
      title="排版"
      defaultOpen
      summary={`${CASE_LABEL[p.keywordCase]} · Tab ${p.tabWidth} · ${INDENT_LABEL[p.indentStyle]}`}
    >
      <SettingsRow
        id="sql-format-case" keywords={["SQL", "关键字大小写", "大写", "小写", "keyword case"]}
        valueText={CASE_LABEL[p.keywordCase]} label="关键字大小写" sub="默认保持原样，避免无意义的 diff"
        control={<SettingsChoice label="关键字大小写" value={p.keywordCase}
          options={(Object.keys(CASE_LABEL) as SqlFormatPrefs["keywordCase"][]).map((value) => ({ value, label: CASE_LABEL[value] }))}
          onChange={(value) => save({ keywordCase: value as SqlFormatPrefs["keywordCase"] })} />}
      />
      <SettingsRow
        id="sql-format-indent" keywords={["SQL", "缩进风格", "标准", "表格", "indent"]}
        valueText={INDENT_LABEL[p.indentStyle]} label="缩进风格" sub="表格风格把 SELECT 列竖向对齐"
        control={<SettingsChoice label="缩进风格" value={p.indentStyle}
          options={(Object.keys(INDENT_LABEL) as SqlFormatPrefs["indentStyle"][]).map((value) => ({ value, label: INDENT_LABEL[value] }))}
          onChange={(value) => save({ indentStyle: value as SqlFormatPrefs["indentStyle"] })} />}
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
          onChange={(value) => save({ logicalOperatorNewline: value as SqlFormatPrefs["logicalOperatorNewline"] })} />}
      />
    </SettingsGroup>

    <SettingsGroup
      title="宽度与方言"
      summary={`${dialectLabel} · 长表达式 ${p.expressionWidth} 字符起折 · 语句间 ${p.linesBetweenQueries} 空行`}
    >
      <SettingsRow
        id="sql-format-dialect" keywords={["SQL", "方言", "Oracle", "MySQL", "PostgreSQL", "SQL Server", "DB2", "SQLite", "dialect"]}
        valueText={dialectLabel} label="方言" sub="手动指定会覆盖按连接自动推断"
        control={<SettingsChoice label="SQL 方言" value={p.dialect}
          options={SQL_DIALECTS.map((item) => ({ value: item.value, label: item.label }))}
          onChange={(value) => save({ dialect: value as SqlDialect })} />}
      />
      <SettingsRow
        id="sql-format-width" keywords={["SQL", "长表达式", "换行宽度", "expression width"]}
        valueText={`${p.expressionWidth} 字符`} label="长表达式折行宽度" sub="候选列表等长表达式超过该宽度时换行"
        control={<SettingsField value={p.expressionWidth} type="number" min={1} max={200} unit="字符"
          ariaLabel="长表达式折行宽度" validate={integerRange(1, 200, "字符")}
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
  </Card>;
}
