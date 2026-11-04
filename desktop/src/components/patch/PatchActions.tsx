import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { failureText } from "../../lib/friendlyError";

/** 像绝对路径就行——真正的落盘校验在后端 `patch_set_out_dir`。 */
function looksAbsolute(v: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(v) || v.startsWith("/");
}

/**
 * 底部动作条：输出目录 / 挂 SQL / 阻断提示 / 生成按钮。
 *
 * 从 PatchWorkspace 抽出来是为了守住 300 行门禁——这条不是装饰：动作条里有自己的
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
  progress,
  onCancel,
  count,
  zipName,
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
  /** 出包进度：`done/total` 条目。刚点下去还没收到第一页时为 null。 */
  progress: { done: number; total: number } | null;
  onCancel: () => void;
  count: number;
  /** 出包后的文件名（由描述 + 日期算出），确认框里给用户对一遍。 */
  zipName: string;
  canBuild: boolean;
  onBuild: () => void;
}) {
  // 输出目录用受控草稿：失焦只校验格式，落盘必须显式保存。
  // 以前 onBlur 直接调 onSaveDir——误敲一个路径、点到别处，配置就被改写、
  // 磁盘还多出一个目录，无确认无撤销。
  const [draft, setDraft] = useState(dir);
  const [askBuild, setAskBuild] = useState(false);
  const [savingDir, setSavingDir] = useState(false);
  const savingDirRef = useRef(false);
  useEffect(() => setDraft(dir), [dir]);
  const dirty = draft.trim() !== dir;

  const commitDir = () => {
    if (savingDirRef.current || building) return;
    const v = draft.trim();
    if (!v || v === dir) return;
    if (!looksAbsolute(v)) {
      toast("这不像绝对路径（如 D:\\NC技术\\待上线补丁），不会保存", "error");
      return;
    }
    savingDirRef.current = true; setSavingDir(true);
    void onSaveDir(v).catch((x) => toast(failureText("保存输出目录", x), "error")).finally(() => { savingDirRef.current = false; setSavingDir(false); });
  };

  return (
    <div className="pk-actions">
      <div className="pk-action-meta"><div className="pk-out">
        <span>输出目录</span>
        <input
          aria-label="补丁输出目录"
          value={draft}
          disabled={savingDir || building}
          placeholder="D:\\NC技术\\待上线补丁"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && !looksAbsolute(v)) {
              toast("这不像绝对路径（如 D:\\NC技术\\待上线补丁）——格式不对，不会保存", "error");
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) commitDir();
            if (e.key === "Escape" && !savingDir) setDraft(dir);
          }}
        />
        {dirty && (
          <>
            <button type="button" className="pk-link" disabled={savingDir || building} aria-busy={savingDir} onClick={commitDir}>
              {savingDir ? <><Icon name="spinner" size={11} className="animate-spin" />保存中</> : "保存"}
            </button>
            <button type="button" className="pk-link" disabled={savingDir || building} onClick={() => setDraft(dir)}>
              撤销
            </button>
          </>
        )}
        <OriginBadge origin={origin} />
      </div>

      <div className="pk-sql" data-filled={sqls.length > 0 || undefined}>
        <Icon name="database" size={13} />
        {sqls.length === 0 ? (
          <span>没挂 SQL</span>
        ) : (
          sqls.map((s) => (
            <span key={s} className="pk-sql-item" title={s}>
              <span className="pk-sql-name">{s.split(/[\\/]/).pop()}</span>
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
      {building && (
        <>
          <span className="pk-live" role="status">
            {progress ? `正在写入 ${progress.done}/${progress.total} 个条目…` : "正在准备出包…"}
          </span>
          <button type="button" className="pk-link" onClick={onCancel}>
            取消出包
          </button>
        </>
      )}
      {dirty && draft.trim() && (
        <span className="pk-pill" data-tone="warn" title="输入框里是新的路径，但还没落盘：现在出包仍会打到旧目录">
          <Icon name="alertTriangle" size={11} />
          输出目录未保存
        </span>
      )}
      </div><button
        type="button"
        className="pk-btn pk-btn-primary"
        // 草稿脏时必须挡住出包：输入框里明写着新路径，包却落到旧目录，事后很难发现。
        // 落盘是显式动作（见上面 commitDir 的注释），所以这里不替用户自动保存。
        disabled={building || !canBuild || !!dirty}
        title={dirty ? "输出目录改了还没保存：先点「保存」，否则包会打到旧目录" : undefined}
        onClick={() => setAskBuild(true)}
      >
        <Icon name="package" size={13} />
        {building ? "出包中…" : `生成补丁包（${count} 项）`}
      </button>
      <ConfirmDialog
        open={askBuild}
        title="确认出包"
        confirmLabel={`生成 ${count} 项`}
        description={
          <>
            会把这 <b>{count}</b> 个文件打进 <b>{zipName}</b>，落到 <code>{dir}</code>。
            同名包若已存在，会先复制成 <code>.bak-时间戳</code> 再覆盖；出包后可用横幅上的
            「回滚到出包前」换回来。
          </>
        }
        onCancel={() => setAskBuild(false)}
        onConfirm={() => {
          setAskBuild(false);
          onBuild();
        }}
      />
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
        aria-label="附带的 SQL 文件路径"
        value={value}
        placeholder="D:\\nc\\aier_crossborrow_ddl.sql"
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) commit();
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
