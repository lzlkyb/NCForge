import { useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { patchRestoreBackup, patchReveal, type PatchBuildResult } from "../../lib/patch";
import { failureText } from "../../lib/friendlyError";

/**
 * 出包结果横幅。
 *
 * 两段都要有：成功那一行说「打到哪了」，`notes` 是后端在出包过程中发现、
 * 但不该阻断的问题（目前唯一一条是「SQL 文件名含非 ASCII，在 GBK 中间件上解压
 * 可能乱码」）。以前 `notes` 后端产出了、前端一个字段都没读——唯一的提醒被静默丢掉，
 * 用户直到在服务器上解压出乱码文件名才回来找原因。
 */
export function BuildBanner({ result }: { result: PatchBuildResult }) {
  const [rollingBack, setRollingBack] = useState(false);
  const [rolledBack, setRolledBack] = useState(false);
  const [askRollback, setAskRollback] = useState(false);
  const rollback = async () => {
    if (!result.backup) return;
    setAskRollback(false);
    setRollingBack(true);
    try {
      await patchRestoreBackup(result.zipPath, result.backup);
      setRolledBack(true);
      toast("已回滚：补丁包恢复成出包前的那一份", "success");
    } catch (e) {
      toast(failureText("回滚补丁包", e), "error");
    } finally {
      setRollingBack(false);
    }
  };
  const backupName = result.backup?.split(/[\\/]/).pop();
  return (
    <>
      <div className="pk-banner" data-tone={rolledBack ? "warn" : "ok"}>
        <Icon name={rolledBack ? "refresh" : "check"} size={13} />
        <span>
          {rolledBack ? (
            <>
              已回滚到出包前 <b>{result.zipPath}</b> 现在是备份 {backupName} 的内容（备份本身保留）
            </>
          ) : (
            <>
              已生成 <b>{result.zipPath}</b>（{result.entries} 个 zip 条目，含目录 ·{" "}
              {result.javaCount} java · {result.classCount} class）
              {result.backup && (
                <span title={result.backup}>
                  {" "}· 旧包已备份为 {backupName}
                </span>
              )}
            </>
          )}
        </span>
        <span className="pk-sp" />
        {result.backup && (
          <button
            type="button"
            className="pk-link"
            disabled={rollingBack || rolledBack}
            title={rolledBack ? "已经回滚过；备份文件仍保留" : `用 ${result.backup} 覆盖回正式包`}
            onClick={() => setAskRollback(true)}
          >
            {rolledBack ? "已回滚" : rollingBack ? "回滚中…" : "回滚到出包前"}
          </button>
        )}
        <button
          type="button"
          className="pk-link"
          onClick={() => void patchReveal(result.zipPath).catch((e) => toast(failureText("打开补丁包位置", e), "error"))}
        >
          打开位置
        </button>
      </div>
      <ConfirmDialog
        open={askRollback}
        variant="destructive"
        title="回滚到出包前？"
        confirmLabel="回滚"
        description={
          <>
            当前包 <b>{result.zipPath.split(/[\\/]/).pop()}</b> 会被覆盖成出包前的那一份
            （{result.backup?.split(/[\\/]/).pop()}）。备份文件本身会保留，可再次回滚。
          </>
        }
        onCancel={() => setAskRollback(false)}
        onConfirm={() => void rollback()}
      />
      {result.notes.map((note, i) => (
        // key 带上下标：note 是后端产出的文案，两条内容相同（比如两个文件同一个
        // 非 ASCII 原因）就是重复 key，React 会只保留一条并警告。列表整体重算、
        // 不增删不重排，下标做 key 稳定。
        <div key={`${i}-${note}`} className="pk-banner" data-tone="warn">
          <Icon name="alertTriangle" size={13} />
          <span>{note}</span>
        </div>
      ))}
    </>
  );
}
