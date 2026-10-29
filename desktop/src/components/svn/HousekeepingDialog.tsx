import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "../ui/icon";
import { Modal } from "../ui/Modal";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { toast } from "../ui/toast";
import {
  formatBytes,
  formatRevTime,
  friendlySvnError,
  svnBackupDelete,
  svnHousekeeping,
  svnReviewPrune,
} from "../../lib/svn";

const KIND_LABEL: Record<string, string> = { revert: "撤销", resolve: "冲突" };

type Pending = { mode: "one"; name: string } | { mode: "all" } | null;

/**
 * 维护面板：撤销/冲突备份的盘点与清理 + 审查标记清理。
 *
 * 解决的是「只增不删」（审查报告 P2-18 ⑧⑩）：撤销和冲突二选一前都会往工作副本
 * 旁边丢一个 `.ncforge-*` 目录，日积月累既占空间也没人知道能不能删；
 * `svn_review_prune` 后端早就写好，却一直没有调用方（死代码）。
 *
 * 删除只传**目录名**，路径解析与白名单校验全在后端（`svn_backup::confirm_target`）：
 * 前端手里的名字来自一次盘点，但名字仍可能被伪造，校验不能放在这一侧。
 */
export function HousekeepingDialog({
  open,
  onClose,
  onPruned,
}: {
  open: boolean;
  onClose: () => void;
  onPruned: () => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<null | "prune" | "delete">(null);
  const [pending, setPending] = useState<Pending>(null);

  const info = useQuery({
    queryKey: ["svn-housekeeping"],
    queryFn: svnHousekeeping,
    enabled: open,
    retry: false,
  });

  const backups = info.data?.backups ?? [];
  const targets = pending?.mode === "all" ? backups.map((b) => b.name) : pending ? [pending.name] : [];

  const remove = async (names: string[]) => {
    setBusy("delete");
    try {
      const r = await svnBackupDelete(names);
      if (r.failed.length === 0) {
        toast(`已删除 ${r.deleted} 个备份，释放 ${formatBytes(r.bytes)}`, "success");
      } else {
        // 部分失败：删掉的不可能回来，把「成功了几个」和第一条原因一起说，
        // 别把整批报成失败——那会把已经释放的空间瞒掉。
        const more = r.failed.length > 1 ? ` 等 ${r.failed.length} 个` : "";
        toast(
          `已删除 ${r.deleted} 个（释放 ${formatBytes(r.bytes)}）；${r.failed[0].name}${more} 失败：${r.failed[0].message}`,
          "error",
        );
      }
    } catch (e) {
      toast(friendlySvnError(e), "error");
    } finally {
      setBusy(null);
      // 删除是逐个进行的，部分成功也要重算列表
      void qc.invalidateQueries({ queryKey: ["svn-housekeeping"] });
    }
  };

  const prune = async () => {
    setBusy("prune");
    try {
      const left = await svnReviewPrune();
      toast(`已清理失效标记，还剩 ${left} 条有效的`, "success");
      void qc.invalidateQueries({ queryKey: ["svn-housekeeping"] });
      // 改动列表的审查进度是基于标记算的，清完要让上层重扫一次
      onPruned();
    } catch (e) {
      toast(friendlySvnError(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const totalBytes = info.data?.totalBytes ?? 0;
  const stale = info.data?.reviewStale ?? 0;

  return (
    <>
      <Modal open={open} onClose={onClose} ariaLabel="维护" className="vc-dialog vc-dialog-hk">
        <h3>
          <Icon name="shield" size={14} /> 维护
          <span className="vc-hk-sub">撤销备份与审查标记</span>
        </h3>

        {info.error && (
          <div className="vc-alert" data-tone="warn">
            <Icon name="alert" size={13} />
            <span style={{ flex: 1 }}>{friendlySvnError(info.error)}</span>
            <button type="button" className="vc-btn vc-btn-sm" onClick={() => void info.refetch()}>
              重试
            </button>
          </div>
        )}

        <div className="vc-hk-sec">
          <div className="vc-hk-title">
            <b>撤销 / 冲突备份</b>
            <span>
              {backups.length} 个目录 · {formatBytes(totalBytes)}
            </span>
          </div>
          <p className="vc-hk-note">
            撤销与冲突二选一前都会自动备份，落在工作副本旁边的 <code>.ncforge-*</code> 目录里。
            它们不进仓库，也不会自己消失。
            {info.data?.baseDir ? <span className="vc-hk-path">位置：{info.data.baseDir}</span> : null}
          </p>

          {backups.length === 0 ? (
            <div className="vc-hk-empty">
              {info.isPending ? "正在盘点…" : "还没有备份。撤销过文件或解决过冲突之后，这里会出现记录。"}
            </div>
          ) : (
            <div className="vc-hk-list">
              {backups.map((b) => (
                <div className="vc-hk-row" key={b.path}>
                  <span className="vc-hk-tag" data-k={b.kind}>
                    {KIND_LABEL[b.kind] ?? b.kind}
                  </span>
                  <span className="vc-hk-name" title={b.path}>
                    {b.name}
                    <span className="vc-hk-when">{formatRevTime(b.atMs)}</span>
                  </span>
                  <span className="vc-hk-num">{b.files} 个文件</span>
                  <span className="vc-hk-num">{formatBytes(b.bytes)}</span>
                  <button
                    type="button"
                    className="vc-hk-del"
                    title={`删除 ${b.name}`}
                    disabled={busy !== null}
                    onClick={() => setPending({ mode: "one", name: b.name })}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="vc-hk-foot">
            <span className="vc-hk-hint">
              {backups.length > 0 ? "删掉就找不回来了（这些文件不在 SVN 里）" : ""}
            </span>
            <button
              type="button"
              className="vc-btn vc-btn-sm vc-btn-danger"
              disabled={busy !== null || backups.length === 0}
              onClick={() => setPending({ mode: "all" })}
            >
              全部删除
            </button>
          </div>
        </div>

        <div className="vc-hk-sec">
          <div className="vc-hk-title">
            <b>审查标记</b>
            <span>共 {info.data?.reviewTotal ?? 0} 条</span>
          </div>
          <p className="vc-hk-note">
            标记按「路径 + BASE 版本 + 修改时间 + 长度」四项校验，任一项变了就失效。这里统计的
            「已失效」只按文件本身判（被改过、已不在盘上）；版本号有没有变要扫一遍工作副本才知道。
            失效标记不生效，但还留在 <code>svn-review.json</code> 里。
          </p>
          <div className="vc-hk-mk">
            <div className="vc-hk-mk-cell">
              <b>{info.data?.reviewValid ?? 0}</b>
              <span>仍然有效</span>
            </div>
            <div className="vc-hk-mk-cell" data-tone={stale > 0 ? "stale" : undefined}>
              <b>{stale}</b>
              <span>已失效</span>
            </div>
            <div className="vc-hk-mk-cell">
              <b>{info.data?.reviewTotal ?? 0}</b>
              <span>合计</span>
            </div>
          </div>
          <div className="vc-hk-foot">
            <span className="vc-hk-hint">
              {stale > 0 ? `清理后文件里会少 ${stale} 条无效记录` : "没有失效标记，不需要清理"}
            </span>
            <button
              type="button"
              className="vc-btn vc-btn-sm"
              disabled={busy !== null || stale === 0}
              onClick={() => void prune()}
            >
              {busy === "prune" ? "清理中…" : "清理失效标记"}
            </button>
          </div>
        </div>

        <div className="vc-dialog-foot">
          <button type="button" className="vc-btn" onClick={() => void info.refetch()} disabled={busy !== null}>
            刷新
          </button>
          <button type="button" className="vc-btn vc-btn-primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={pending !== null}
        variant="destructive"
        // 嵌在维护弹窗里：两个都 portal 到 body，必须抬层级，否则确认框会被遮罩盖住
        zIndex={1100}
        title={pending?.mode === "all" ? `删除全部 ${backups.length} 个备份？` : "删除这个备份？"}
        confirmLabel="删除"
        confirmDisabled={busy !== null}
        description={
          pending?.mode === "all"
            ? `共 ${formatBytes(totalBytes)}，目录里的文件会一起删掉。这些文件不在 SVN 里，删了就找不回来了。`
            : `目录 ${pending?.name ?? ""} 里的备份文件会一起删掉，删了就找不回来了。`
        }
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const list = targets;
          setPending(null);
          void remove(list);
        }}
      />
    </>
  );
}
