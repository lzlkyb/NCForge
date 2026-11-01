// 底部面板的「书签」标签。
//
// 与「待办」的区别：待办是扫出来的（只读），书签是用户自己点的（可增删）。
// 一个文件可以有多条，按加入顺序列出。
import { Icon } from "../ui/icon";
import { baseName } from "../../lib/workspace";
import { clearBookmarks, removeBookmark, useBookmarks } from "../../lib/bookmarks";

export function BookmarkPanel({
  root,
  onOpenAt,
}: {
  root: string;
  onOpenAt: (path: string, line: number) => void;
}) {
  const items = useBookmarks(root);
  return (
    <div className="wb-panel-body">
      <div className="wb-panel-note">
        书签 · {items.length} 条（F11 在光标处加/去）
        {items.length > 0 && (
          <button type="button" className="wb-status-btn" onClick={() => clearBookmarks()}>
            全部清除
          </button>
        )}
      </div>
      {items.length === 0 && (
        <div className="wb-panel-note">还没有书签：把光标放到一行上按 F11。</div>
      )}
      {items.map((b) => (
        <div key={`${b.path}#${b.line}`} className="wb-prow" style={{ cursor: "default" }}>
          <Icon name="copy" size={14} className="wb-prow-info" />
          <button
            type="button"
            className="wb-prow-msg"
            style={{ textAlign: "left", background: "none", border: 0, padding: 0, color: "inherit" }}
            title={`${b.path}:${b.line}`}
            onClick={() => onOpenAt(b.path, b.line)}
          >
            {b.note || "（空行）"}
          </button>
          <span className="wb-prow-loc">
            {baseName(b.path)}:{b.line}
          </span>
          <button
            type="button"
            className="wb-icon-btn"
            title="删除这条书签"
            onClick={() => removeBookmark(b.path, b.line)}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
