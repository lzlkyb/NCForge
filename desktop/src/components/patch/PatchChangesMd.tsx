import { DRAFT_FIELDS, ymd, type MdDraft, type PatchItem } from "../../lib/patch";

/**
 * CHANGES.md 的编辑与预览。
 *
 * 分两段是刻意的：
 * - 上半段手写（功能说明 / 问题现象 / 原因 / 修改点 / 影响范围），分节标题沿用历史包里
 *   真实用过的写法——运维和测试是按这五节读的，换个标题就得重学一遍。
 * - 下半段只读：落位层、增删行数、涉及方法都由出包时对比 SVN 基线生成。
 *   这里**不预览增删行数**——前端手上没有基线，编一个数字出来比不显示更糟。
 */
export function ChangesMd({
  draft,
  onChange,
  items,
  sqls,
}: {
  draft: MdDraft;
  onChange: (field: keyof MdDraft, value: string) => void;
  items: PatchItem[];
  sqls: string[];
}) {
  const layered = items.filter((it) => it.section !== "hotwebs" && it.section !== "upm");
  return (
    <div className="pk-md">
      <div className="pk-md-bar">
        <span>手写段会原样放在 CHANGES.md 最前，自动段在出包时追加</span>
        <span className="pk-sp" />
        <span>UTF-8 · LF</span>
      </div>
      <div className="pk-md-body">
        {DRAFT_FIELDS.map((f) => (
          <div key={f} className="pk-sec">
            <div className="pk-sec-t">
              {f}
              <span className="pk-tag">手写</span>
            </div>
            <textarea
              className="pk-edit"
              rows={f === "修改点" || f === "影响范围" ? 4 : 2}
              value={draft[f]}
              placeholder={PLACEHOLDER[f]}
              spellCheck={false}
              onChange={(e) => onChange(f, e.target.value)}
            />
          </div>
        ))}

        <div className="pk-sec">
          <div className="pk-sec-t">
            代码改动（打包时对比 SVN 基线自动生成）
            <span className="pk-tag" data-auto>
              只读
            </span>
          </div>
          <div className="pk-auto">
            <div className="h">- 打包日期：{ymd()}</div>
            <br />
            {layered.length > 0 && (
              <>
                <div className="h">- 落位层（按 NC home 原始 jar 判定）：</div>
                {layered.map((it) => (
                  <div key={it.path}>
                    {"  - "}
                    {it.label} → <span className="k">{it.layer?.why ?? "标准层"}</span>
                  </div>
                ))}
                <br />
              </>
            )}
            <div className="muted">
              每条的「新增 N 行 / 删除 M 行」与「涉及方法」在出包时由后端比对 SVN 基线写入。
            </div>
            {sqls.length > 0 && (
              <>
                <br />
                <div className="h">- SQL（需人工执行，时机见上文影响范围）：</div>
                {sqls.map((s) => (
                  <div key={s}>{"  - "}{s.split(/[\\/]/).pop()}</div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const PLACEHOLDER: Record<keyof MdDraft, string> = {
  功能说明: "这次改动让用户能做什么（一句话）",
  问题现象: "改之前是什么表现、谁在什么场景下撞上",
  原因: "标准产品不支持 / 逻辑写错 / 配置缺失",
  修改点: "- 单据与按钮：…\n- 校验规则：…",
  影响范围: "涉及单据、回归点、上线动作（要不要重启中间件、要不要比对生产 upm）",
};
