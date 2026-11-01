// 底部面板的「类型层级」标签：光标所在类型的父类型与子类型。
//
// 数据来自 `lib/typeHierarchy`（jdt.ls 扩展 bundle 的 `ncforge.typeHierarchy`）。
// 列表按 depth 缩进：菱形继承下深度取最短路径，与 IDEA 的树形观感一致。
// 没源码位置的条目（java.lang.Object、没附源码的 jar 类）不给点击——点了也没处可去。
import { Icon } from "../ui/icon";
import { useTypeState, openTypeEntry, openTypeHierarchy, kindLabel, typeHierarchyKey, type TypeEntry } from "../../lib/typeHierarchy";
import { baseName } from "../../lib/workspace";

export function TypeHierarchyPanel() {
  const st = useTypeState();
  const key = typeHierarchyKey();

  if (!st.root) {
    return (
      <div className="wb-panel-body">
        <div className="wb-panel-note">
          把光标放到类名 / 接口名上，按 {key}，或点下面的按钮。
          {st.error && <span className="wb-prow-warn"> {st.error}</span>}
        </div>
        <div className="wb-panel-note">
          <button type="button" className="wb-status-btn" onClick={() => void openTypeHierarchy()}>
            查当前光标处的类型层级
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="wb-panel-body">
      <div className="wb-panel-note">
        {st.loading ? "正在查询…" : `${st.root.qualifiedName} · ${kindLabel(st.root.kind)}${st.root.abstract ? "（抽象）" : ""}`}
      </div>
      <Section title="父类型（它继承 / 实现了谁）" icon="arrowUp" items={st.supertypes} empty="没有父类型" />
      <Section title="子类型（谁继承 / 实现了它）" icon="chevronDown" items={st.subtypes} empty="没有子类型" />
    </div>
  );
}

function Section({
  title,
  icon,
  items,
  empty,
}: {
  title: string;
  icon: "arrowUp" | "chevronDown";
  items: TypeEntry[];
  empty: string;
}) {
  return (
    <>
      <div className="wb-panel-note">
        {title} · {items.length} 个
      </div>
      {items.length === 0 && <div className="wb-panel-note">{empty}</div>}
      {items.map((it, i) => (
        <Row key={`${it.qualifiedName}#${i}`} it={it} icon={icon} />
      ))}
    </>
  );
}

function Row({ it, icon }: { it: TypeEntry; icon: "arrowUp" | "chevronDown" }) {
  const label = (
    <>
      <Icon name={icon} size={14} className="wb-prow-info" />
      <span className="wb-prow-msg">
        {it.name}
        <span className="wb-diag-path">
          {" "}
          {kindLabel(it.kind)}
          {it.abstract ? " · 抽象" : ""}
          {it.direct ? " · 直接" : ""}
        </span>
      </span>
      <span className="wb-prow-loc">{it.path ? `${baseName(it.path)}:${it.line}` : it.uri ? "jar" : "无源码"}</span>
    </>
  );
  // depth 从 1 开始（root 不在这里）；每层缩进 16px，封顶避免深层链把文字挤没
  const indent = Math.min(it.depth, 6) * 16;
  if (!it.path && !it.uri) {
    return (
      <div className="wb-prow" style={{ paddingLeft: 8 + indent }} title="没有可打开的源码位置">
        {label}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="wb-prow"
      style={{ paddingLeft: 8 + indent }}
      title={`${it.qualifiedName}${it.path ? ` — ${it.path}:${it.line}` : ""}`}
      onClick={() => openTypeEntry(it)}
    >
      {label}
    </button>
  );
}
