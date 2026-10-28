import { useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";

/**
 * 底部动作条：输出目录 / 挂 SQL / 阻断提示 / 生成按钮。
 *
 * 从 PatchTab 抽出来是为了守住 300 行门禁——这条不是装饰：动作条里有自己的
 * 输入态（SQL 路径的编辑中状态），留在页面里会和页面的勾选态挤在一个组件，
 * 「哪个 state 归谁」就说不清了。
 */
export function PatchActions({
  dir,
  origin,
  onSaveDir,
  sqls,
  onSqls,
  blockedCount,
  deletedCount,
  building,
  count,
  canBuild,
  onBuild,
}: {
  dir: string;
  /** 当前路径是哪来的。只在「还没被人改过」时有值；null = 不解释。 */
  origin: { source: string; exists: boolean } | null;
  onSaveDir: (v: string) => Promise<void>;
  sqls: string[];
  onSqls: (next: string[]) => void;
  blockedCount: number;
  deletedCount: number;
  building: boolean;
  count: number;
  canBuild: boolean;
  onBuild: () => void;
}) {
  return (
    <div className="pk-actions">
      <div className="pk-out">
        <span>输出目录</span>
        <input
          key={dir}
          defaultValue={dir}
          placeholder="D:\\NC技术\\待上线补丁"
          spellCheck={false}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== dir) void onSaveDir(v).catch((x) => toast(String(x), "error"));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        <OriginBadge origin={origin} />
      </div>

      <div className="pk-sql" data-filled={sqls.length > 0 || undefined}>
        <Icon name="database" size={13} />
        {sqls.length === 0 ? (
          <span>没挂 SQL</span>
        ) : (
          sqls.map((s) => (
            <span key={s} className="pk-sql-item" title={s}>
              {s.split(/[\\/]/).pop()}
              <button
                type="button"
                title="移除"
                onClick={() => onSqls(sqls.filter((p) => p !== s))}
              >
                <Icon name="close" size={10} />
              </button>
            </span>
          ))
        )}
        <SqlAdder onAdd={(p) => onSqls(sqls.includes(p) ? sqls : [...sqls, p])} />
      </div>

      <span className="pk-sp" />

      {blockedCount > 0 && (
        <span className="pk-pill" data-tone="bad">
          <Icon name="alert" size={11} />
          {blockedCount} 个阻断
        </span>
      )}
      {deletedCount > 0 && (
        <span className="pk-pill" data-tone="warn">
          <Icon name="alertTriangle" size={11} />
          {deletedCount} 个删除文件不进包
        </span>
      )}
      <button
        type="button"
        className="pk-btn pk-btn-primary"
        disabled={building || !canBuild}
        onClick={onBuild}
      >
        <Icon name="package" size={13} />
        {building ? "出包中…" : `生成补丁包（${count} 项）`}
      </button>
    </div>
  );
}

/**
 * 输出目录的来源徽标。
 *
 * `config`（用户自己设的）与 `none`（空着，placeholder 已经说明问题）都不显示——
 * 只在「这个路径是程序猜的」时候解释，因为那才是用户需要对一下的地方。
 */
function OriginBadge({ origin }: { origin: { source: string; exists: boolean } | null }) {
  if (!origin || origin.source === "config" || origin.source === "none") return null;
  if (origin.source === "suggest") {
    return (
      <span
        className="pk-origin"
        data-tone="warn"
        title="工作台按工作副本位置猜的路径，现在还不存在。生成时会创建它；不想放这里就改成别的目录。"
      >
        <Icon name="alertTriangle" size={10} />
        建议目录 · 还不存在
      </span>
    );
  }
  const text = origin.source === "nc-patch" ? "继承 nc-patch 脚本" : "自动找到";
  return (
    <span className="pk-origin" title={`这个路径是${text}的，不是手填的`}>
      {text}
    </span>
  );
}

/** 挂 SQL：手输绝对路径。工程里没装 dialog 插件，输入比为一个功能引依赖更省事。 */
function SqlAdder({ onAdd }: { onAdd: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");

  if (!open) {
    return (
      <button type="button" className="pk-link" onClick={() => setOpen(true)}>
        <Icon name="plus" size={11} />
        挂 SQL
      </button>
    );
  }

  const commit = () => {
    const v = value.trim();
    if (!v) return;
    if (!/^[A-Za-z]:[\\/]/.test(v) && !v.startsWith("/")) {
      toast("要给 SQL 文件的绝对路径（如 D:\\nc\\ddl.sql）", "error");
      return;
    }
    onAdd(v);
    setValue("");
    setOpen(false);
  };

  return (
    <span className="pk-sql-add">
      <input
        autoFocus
        value={value}
        placeholder="D:\\nc\\aier_crossborrow_ddl.sql"
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <button type="button" className="pk-link" onClick={commit}>
        确定
      </button>
      <button type="button" className="pk-link" onClick={() => setOpen(false)}>
        取消
      </button>
    </span>
  );
}
