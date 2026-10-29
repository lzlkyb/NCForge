import { Icon } from "../ui/icon";
import { layerText, pairState, sectionLabel, type PatchItem } from "../../lib/patch";

/**
 * 选中项的详情卡：模块 / 产物 / 落位，外加一句「为什么判成这一层」。
 *
 * 「为什么」这一行不能省。层判错意味着补丁装到服务器上根本不生效，
 * 而这是唯一能让工程师当场反驳「不对，这个类在 hyext jar 里」的地方——
 * 所以这里还给**改判入口**（自动 / 标准层 / hyext）。后端一直有 `forceHyext`/
 * `forceStd`（一路传到 `locate_layer`），界面以前恒传空数组，报错文案却写着
 * 「或手动选层」，等于指一个不存在的操作。
 */
export function ItemDetail({
  item,
  override,
  onForce,
}: {
  item: PatchItem;
  /** 当前改判：null = 自动。 */
  override: "hy" | "std" | null;
  onForce: (v: "hy" | "std" | null) => void;
}) {
  const pair = pairState(item);
  // 只有「要查 jar 判层」的 java 才有层可选：upm / hotwebs 是整文件替换
  const canForce = item.section !== "upm" && item.section !== "hotwebs" && item.pkgRel.endsWith(".java");
  return (
    <div className="pk-detail">
      <h4>
        <span className="pk-badge" data-st="M">
          {item.section === "upm" ? "U" : item.section === "hotwebs" ? "W" : "J"}
        </span>
        <span className="pk-detail-name" title={item.label}>
          {item.label}
        </span>
        <span className="pk-sp" />
        <span className="pk-lay" data-l={layerText(item) === "hyext" ? "hy" : "std"}>
          {layerText(item)}
        </span>
      </h4>

      <dl className="pk-map">
        <dt>模块</dt>
        <dd>
          {item.module} · {sectionLabel(item.section)}
        </dd>
        <dt>落位</dt>
        <dd title={item.target}>{item.target}/</dd>
        <dt>产物</dt>
        <dd title={item.classes.map((c) => c.name).join("，")}>
          {item.classes.length > 0
            ? `${item.classes.map((c) => c.name).join("、")}${item.outRootUsed ? `（${item.outRootUsed}）` : ""}`
            : "无（整文件替换或不需编译）"}
        </dd>
        <dt>配对</dt>
        <dd data-k={pair.kind}>{pair.kind === "ok" ? pair.text : `${pair.text} — ${pair.title}`}</dd>
      </dl>

      {item.problems.length > 0 && (
        <div className="pk-problems">
          {item.problems.map((p, i) => (
            <div key={i} className="pk-problem" data-level={p.level}>
              <Icon name={p.level === "error" ? "alert" : "alertTriangle"} size={11} />
              {p.text}
            </div>
          ))}
        </div>
      )}

      {canForce && (
        <div className="pk-note">
          <Icon name="info" size={12} />
          <span>层判错就打不到正确位置。改判会重扫一遍并用于出包：</span>
          <span className="pk-sp" />
          {(
            [
              [null, "自动"],
              ["std", "标准层"],
              ["hy", "hyext"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={label}
              type="button"
              className="pk-chip"
              data-on={override === v || undefined}
              onClick={() => onForce(v)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* upm / 网页没有层判定，后端给的 why 是空串（CHANGES.md 生成处同样滤掉空串）——
          不过滤就会渲染出一句空的「层判定：。」 */}
      {item.layer && item.layer.why && (
        <div className="pk-note">
          <Icon name="info" size={12} />
          <span>
            层判定：{item.layer.why}。ic / pu / so / arap 四个默认模块一律 hyext、不查 jar；
            其余模块只查该模块的 hyext jar，命中才升 hyext。
          </span>
        </div>
      )}
    </div>
  );
}
