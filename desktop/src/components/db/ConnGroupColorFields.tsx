import { CONN_COLORS, CONN_COLOR_LABEL, type ConnColor } from "../../lib/dbConnGroups";

/**
 * 连接表单里的「分组 + 颜色」两个字段。
 *
 * 单独成组件只为一件事：`ConnManualForm` 已经 300 行顶格，再塞两个字段就过不了
 * `component-size` 门禁。这里的逻辑本身很少——分组是自由文本（带已有分组的候选列表），
 * 颜色是**固定枚举**，不是让用户填色值。
 */
export function ConnGroupColorFields({
  id,
  group,
  color,
  knownGroups,
  onGroup,
  onColor,
}: {
  id: string;
  group: string;
  color: string;
  knownGroups: string[];
  onGroup: (v: string) => void;
  onColor: (v: string) => void;
}) {
  return (
    <>
      <label htmlFor={`${id}-group`}>分组</label>
      <input
        id={`${id}-group`}
        className="dbx-inp"
        list={`${id}-group-list`}
        value={group}
        placeholder="留空 = 未分组，如「客户 A 生产」"
        onChange={(e) => onGroup(e.target.value)}
      />
      <datalist id={`${id}-group-list`}>
        {knownGroups.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
      <span className="dbx-form-label" id={`${id}-color-label`}>颜色</span>
      <div className="dbx-conn-colors" role="group" aria-labelledby={`${id}-color-label`}>
        <button
          type="button"
          className="dbx-conn-color-none"
          aria-pressed={!color}
          data-on={!color || undefined}
          title="不标记，跟随环境色"
          onClick={() => onColor("")}
        >
          默认
        </button>
        {CONN_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className="dbx-conn-color"
            data-color={c}
            aria-pressed={color === c}
            aria-label={CONN_COLOR_LABEL[c as ConnColor]}
            title={CONN_COLOR_LABEL[c as ConnColor]}
            data-on={color === c || undefined}
            onClick={() => onColor(c)}
          />
        ))}
      </div>
    </>
  );
}
