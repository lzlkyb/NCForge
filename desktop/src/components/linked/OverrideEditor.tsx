import { useState } from "react";
import { Icon } from "../ui/icon";
import {
  actionLabel,
  overrideKey,
  removeOverride,
  upsertOverride,
  type LinkedOverride,
  type OverrideAction,
} from "../../lib/linkedProjects";

const ACTION_OPTIONS: { value: OverrideAction; text: string }[] = [
  { value: "disable", text: "停用工程（连带剪掉它往下传递的依赖）" },
  { value: "front", text: "排前（主工程之后、其它依赖之前）" },
  { value: "add", text: "追加目录（不在任何工程里的类目录 / jar）" },
];

/**
 * 覆盖表编辑（整表草稿 + 一次保存）。
 *
 * 为什么不是「每行一个保存按钮」：后端是全量替换语义，逐条提交会把用户刚加的另一条
 * 冲掉。所以草稿一直在这里攒着，底部一次提交；`dirty` 由草稿与上次落盘值比对得出。
 *
 * 校验只做「明显填不全」这一档（`add` 必须有目录、其余必须有工程名），其余交给后端：
 * 后端会拒绝整张表并给出**中文原因**，直接 toast 出去即可——这里复刻一遍判断逻辑
 * 只会两边慢慢分叉。
 */
export function OverrideEditor({
  draft,
  dirty,
  saving,
  onChange,
  onSave,
  onReset,
}: {
  draft: LinkedOverride[];
  dirty: boolean;
  saving: boolean;
  onChange: (next: LinkedOverride[]) => void;
  onSave: () => void;
  onReset: () => void;
}) {
  const [action, setAction] = useState<OverrideAction>("disable");
  const [target, setTarget] = useState("");
  const [dir, setDir] = useState("");

  const complete = action === "add" ? dir.trim().length > 0 : target.trim().length > 0;

  const add = () => {
    if (!complete) return;
    onChange(upsertOverride(draft, { action, target, dir: action === "add" ? dir : null }));
    setTarget("");
    setDir("");
  };

  return (
    <section className="lnk-sec">
      <h3 className="lnk-sec-title">
        覆盖表
        {dirty && <span className="lnk-dirty">有改动未保存</span>}
        <span className="lnk-hint">
          不改工程文件，只决定工作台 / 编译 / 启动 / 语言服务怎么算类路径
        </span>
      </h3>

      {draft.length === 0 ? (
        <p className="lnk-empty">没有覆盖：完全按各工程的 `.classpath` 走。</p>
      ) : (
        <ul className="lnk-ovs">
          {draft.map((o, i) => (
            <li key={`${overrideKey(o)}-${i}`} className="lnk-ov">
              <span className="lnk-badge" data-kind={o.action}>
                {actionLabel(o.action)}
              </span>
              <span className="lnk-ov-target">
                {o.action === "add" ? (o.dir ?? "") : o.target || "（未填工程名）"}
              </span>
              {o.action !== "add" && o.dir ? <code className="lnk-dir">{o.dir}</code> : null}
              <span className="lnk-sp" />
              <button
                type="button"
                className="lnk-ibtn"
                title="从草稿里移除（保存后才真正生效）"
                onClick={() => onChange(removeOverride(draft, o))}
              >
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="lnk-add">
        <select
          className="lnk-inp sel"
          aria-label="覆盖动作"
          value={action}
          onChange={(e) => setAction(e.target.value as OverrideAction)}
        >
          {ACTION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.text}
            </option>
          ))}
        </select>
        <input
          className="lnk-inp"
          placeholder={action === "add" ? "工程名（可留空）" : "工程名或工程根绝对路径"}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        {action === "add" && (
          <input
            className="lnk-inp mono"
            placeholder="类目录 / jar 的绝对路径"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
        )}
        <button type="button" className="lnk-btn" disabled={!complete} onClick={add}>
          <Icon name="plus" size={12} />
          加入草稿
        </button>
      </div>

      <div className="lnk-actions">
        <button
          type="button"
          className="lnk-btn pri"
          disabled={!dirty || saving}
          onClick={onSave}
        >
          {saving ? "保存中…" : "保存覆盖表"}
        </button>
        <button type="button" className="lnk-btn" disabled={!dirty || saving} onClick={onReset}>
          放弃改动
        </button>
        <span className="lnk-hint">
          保存是整表替换；保存后按服务端返回值刷新（会 trim、去重、把空目录归一成 null）
        </span>
      </div>
    </section>
  );
}
