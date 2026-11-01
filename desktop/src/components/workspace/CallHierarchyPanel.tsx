// 底部面板的「调用层级」标签：当前方法被谁调用、它调用了谁。
//
// 只列一层（数据来自 lib/callHierarchy）：想看更深就点某一行，再从那里发起一次——
// 这比一次展开整棵树更接近排查习惯（顺着一个分支往下走，而不是看一片树）。
import { Icon } from "../ui/icon";
import { useCallState, openCallItem } from "../../lib/callHierarchy";
import { baseName } from "../../lib/workspace";

export function CallHierarchyPanel() {
  const st = useCallState();

  if (!st.root) {
    return (
      <div className="wb-panel-body">
        <div className="wb-panel-note">
          把光标放到方法名上，按 Ctrl+Alt+H 或点右上角「查调用层级」。
          {st.error && <span className="wb-prow-warn"> {st.error}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="wb-panel-body">
      <div className="wb-panel-note">
        {st.loading ? "正在查询…" : `${st.root.name}${st.root.detail ? ` · ${st.root.detail}` : ""}`}
      </div>
      <Section title="被调用（谁调了它）" items={st.incoming} empty="没有找到调用者" />
      <Section title="调用（它调了谁）" items={st.outgoing} empty="它没有调用别的成员" />
    </div>
  );
}

function Section({
  title,
  items,
  empty,
}: {
  title: string;
  items: ReturnType<typeof useCallState>["incoming"];
  empty: string;
}) {
  return (
    <>
      <div className="wb-panel-note">
        {title} · {items.length} 处
      </div>
      {items.length === 0 && <div className="wb-panel-note">{empty}</div>}
      {items.map((it, i) => (
        <button
          type="button"
          key={`${it.uri}#${it.line}#${i}`}
          className="wb-prow"
          title={`${it.path ?? "jar 内"} : ${it.line}`}
          onClick={() => openCallItem(it)}
        >
          <Icon name="gitBranch" size={14} className="wb-prow-info" />
          <span className="wb-prow-msg">
            {it.name}
            {it.detail && <span className="wb-diag-path"> {it.detail}</span>}
          </span>
          <span className="wb-prow-loc">
            {it.path ? baseName(it.path) : "jar"}:{it.line}
          </span>
        </button>
      ))}
    </>
  );
}
