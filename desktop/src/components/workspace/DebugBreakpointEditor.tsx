// 断点编辑表单：条件 / 命中次数 / 日志消息 / 分组。
//
// 从 DebugBreakpoints.tsx 拆出：那一列要放静音开关、组 chip 行和分组徽标，
// 再塞一个五十行的表单就过 300 行门禁了。表单本身无副作用：只回调。
//
// 三个字段都过 breakpointCondition 的静态校验：适配器（java-debug 0.32.0）
// 把 condition / logMessage 留到命中时才交给 JDT 编译，hitCondition 只认纯整数，
// 写错不报错、只是静默不生效——所以保存前必须挡掉（详见该模块注释）。
import { useState } from "react";
import { draftErrors, hasDraftErrors } from "../../lib/breakpointCondition";

export interface BreakpointDraft {
  key: string;
  condition: string;
  hitCondition: string;
  logMessage: string;
  /** 组名；空串 = 默认组。 */
  group: string;
}

/** 一个字段：Enter 保存、Escape 取消（三个文本字段同一套键位，抽出来免三份抄）。 */
function Field({
  label,
  value,
  placeholder,
  list,
  error,
  onChange,
  onEnter,
  onEscape,
}: {
  label: string;
  value: string;
  placeholder: string;
  list?: string;
  /** 静态校验的错误文案；null = 合法。 */
  error?: string | null;
  onChange: (v: string) => void;
  onEnter: () => void;
  onEscape: () => void;
}) {
  return (
    <label className="dbg-bp-field" data-err={error ? "true" : undefined}>
      <span className="dbg-bp-field-label">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        list={list}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onEnter();
          if (e.key === "Escape") onEscape();
        }}
      />
      {error ? <span className="dbg-bp-field-err">{error}</span> : null}
    </label>
  );
}

export function DebugBreakpointEditor({
  draft,
  groupNames,
  onChange,
  onSave,
  onCancel,
}: {
  draft: BreakpointDraft;
  /** 已有组名：分组字段的自动补全来源。 */
  groupNames: string[];
  onChange: (patch: Partial<BreakpointDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [listId] = useState(() => `ncforge-bp-groups-${Math.random().toString(36).slice(2, 8)}`);
  const errors = draftErrors(draft);
  const invalid = hasDraftErrors(errors);
  return (
    <div className="dbg-bp-edit">
      <Field
        label="条件（Java 表达式）"
        value={draft.condition}
        placeholder="如 vo.getCode() != null"
        error={errors.condition}
        onChange={(condition) => onChange({ condition })}
        onEnter={onSave}
        onEscape={onCancel}
      />
      <Field
        label="命中次数"
        value={draft.hitCondition}
        placeholder="如 5（第 5 次命中才停）"
        error={errors.hitCondition}
        onChange={(hitCondition) => onChange({ hitCondition })}
        onEnter={onSave}
        onEscape={onCancel}
      />
      <Field
        label="日志消息（填了就不停）"
        value={draft.logMessage}
        placeholder="如 code = {vo.getCode()}（不支持英文引号）"
        error={errors.logMessage}
        onChange={(logMessage) => onChange({ logMessage })}
        onEnter={onSave}
        onEscape={onCancel}
      />
      <Field
        label="分组（留空 = 默认组，整组可一起静音）"
        value={draft.group}
        placeholder="如 支付流程"
        list={listId}
        onChange={(group) => onChange({ group })}
        onEnter={onSave}
        onEscape={onCancel}
      />
      <datalist id={listId}>
        {groupNames.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
      <div className="dbg-bp-edit-actions">
        <button
          type="button"
          className="dbg-btn dbg-btn-primary"
          disabled={invalid}
          title={invalid ? "有字段不合法：先按红色提示修正" : undefined}
          onClick={onSave}
        >
          保存
        </button>
        <button type="button" className="dbg-btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
