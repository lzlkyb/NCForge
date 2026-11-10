import { CodePreview } from "./CodePreview";
import { ddlScript, type StructDiff } from "../../lib/dbStructDiff";
import { downloadText } from "../../lib/resultExport";
import { copyText } from "../../lib/utils";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";

/**
 * 生成的同步脚本。
 *
 * **只给脚本，不给「一键执行」**：同一条 `alter table ... modify` 在开发库跑是修结构、
 * 在生产库跑可能是锁表几十分钟。落库这一步必须由人挑着跑——这里只负责把「为什么改」
 * 与「改什么」放在一起给人看。
 */
export function StructDiffScript({ diff }: { diff: StructDiff }) {
  if (diff.ddl.length === 0) {
    return <div className="dbx-hint">两侧结构一致，没有需要执行的语句。</div>;
  }
  const text = ddlScript(diff);
  const name = `struct-${diff.right.label.replace(/[^\w.-]+/g, "_")}.sql`;
  return (
    <div className="dbx-diff-sql">
      <div className="dbx-diff-sql-hd">
        同步脚本（{diff.ddl.length} 条，把右侧改成左侧）
        <span className="dbx-sp" />
        <button
          type="button"
          className="dbx-btn ghost"
          onClick={() => void copyText(text, () => toast(`已复制 ${diff.ddl.length} 条语句`, "success"), () => toast("复制失败，可改用「保存脚本」", "error"))}
        >
          <Icon name="copy" size={12} />
          复制
        </button>
        <button type="button" className="dbx-btn ghost" onClick={() => downloadText(name, text, "text/plain", false)}>
          <Icon name="download" size={12} />
          保存脚本
        </button>
      </div>
      <div className="dbx-diff-sql-body">
        {diff.ddl.map((s, i) => (
          <div key={`${i}:${s.sql}`} className="dbx-diff-stmt" data-destructive={s.destructive || undefined}>
            <div className="dbx-diff-stmt-why">
              {s.destructive && <span className="dbx-diff-badge" data-status="onlyRight">会丢数据</span>}
              {s.reason}
            </div>
            <CodePreview className="dbx-mono" text={s.sql} label={`同步语句 ${i+1}`}/>
          </div>
        ))}
      </div>
    </div>
  );
}
