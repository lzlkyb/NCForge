import { useEffect, useState } from "react";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { formatBytes } from "../../lib/serverLog";

interface Props {
  open: boolean;
  target: "middleware" | "client";
  /** 当前日志文件体积（字节），只用来让确认文案说清要清掉多少。 */
  size: number;
  onCancel: () => void;
  onConfirm: (archive: boolean) => void;
}

/**
 * 每次打开都回到这个默认值：上一次取消勾选「连归档一起删」不该被记住——
 * 用户点「清除日志」通常就是要腾空间，静默留着归档反而会让人以为没清干净。
 */
const DEFAULT_PURGE_ARCHIVE = true;

/**
 * 清空磁盘日志前的确认。
 *
 * 之所以要弹窗：「清屏」只动视图，这个会真的销毁文件内容，且旧内容没有任何备份。
 */
export function ServiceLogPurgeDialog({ open, target, size, onCancel, onConfirm }: Props) {
  const [archive, setArchive] = useState(DEFAULT_PURGE_ARCHIVE);
  useEffect(() => { if (open) setArchive(DEFAULT_PURGE_ARCHIVE); }, [open]);
  const file = `${target}.log`;
  return <ConfirmDialog open={open} variant="destructive" title={`清除 ${file}？`}
    description={size > 0 ? `当前文件 ${formatBytes(size)}。清空后不可恢复，正在运行的进程会继续往同一个文件写新日志。` : "当前文件已经是空的。正在运行的进程会继续往同一个文件写新日志。"}
    confirmLabel="清除日志" onCancel={onCancel} onConfirm={() => onConfirm(archive)}>
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={archive} onChange={event => setArchive(event.target.checked)} />
      <span>同时删除上次运行的归档 <code>{file}.1</code></span>
    </label>
  </ConfirmDialog>;
}
