import { Icon } from "../ui/icon";
import { layerText, pairState, sectionLabel, type PatchItem } from "../../lib/patch";

/**
 * 选中项的详情卡：模块 / 产物 / 落位，外加一句「为什么判成这一层」。
 *
 * 「为什么」这一行不能省。层判错意味着补丁装到服务器上根本不生效，
 * 而这是唯一能让工程师当场反驳「不对，这个类在 hyext jar 里」的地方。
 */
export function ItemDetail({ item }: { item: PatchItem }) {
  const pair = pairState(item);
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

      {item.layer && (
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
