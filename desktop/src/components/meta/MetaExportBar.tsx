import { useState } from "react";
import { bmfGenExport, type BmfExportResult } from "../../lib/bmf";
import { pickFolder, pickFolderError } from "../../lib/folderPicker";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";

const STATUS_TEXT: Record<BmfExportResult["items"][number]["status"], string> = {
  written: "已写入",
  replaced: "已覆盖",
  skipped: "已跳过",
};

/** BMF 所在目录下的 `gen`：作为默认落盘位置的建议，用户可改。 */
function suggestDir(bmfPath: string): string {
  const dir = bmfPath.replace(/[\\/][^\\/]+$/, "");
  return dir ? `${dir}\\gen` : "";
}

/**
 * 生成物落盘（M5）。
 *
 * 后端只会写 DDL / VO / UPM / 注册清单，不执行 SQL、不碰 NC 安装目录；目标已存在
 * 默认跳过，勾选覆盖才先备份再重写。这里不做二次确认——跳过策略本身已经保证
 * 「第一次点不会毁掉任何东西」，覆盖才需要用户主动勾选。
 */
export function MetaExportBar({ path, disabled = false }: { path: string; disabled?: boolean }) {
  const [targetDir, setTargetDir] = useState(() => suggestDir(path));
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BmfExportResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const pick = async () => {
    try {
      const dir = await pickFolder({ title: "选择生成物落盘目录", defaultPath: targetDir || undefined });
      if (dir) setTargetDir(dir);
    } catch (e) {
      setErr(pickFolderError(e));
    }
  };

  const run = async () => {
    const dir = targetDir.trim();
    if (!dir) {
      setErr("请先选择目标目录");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await bmfGenExport(path, dir, undefined, overwrite);
      setResult(r);
      toast(`已写入 ${r.written} 个文件${r.skipped ? `，跳过 ${r.skipped} 个` : ""}`, "success");
    } catch (e) {
      // 失败时清掉上一次的结果：否则用户会以为这一轮也写成功了。
      setResult(null);
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="meta-export">
      <div className="meta-export-row">
        <span className="meta-export-label">
          <Icon name="download" size={12} /> 落盘到
        </span>
        <input
          className="meta-export-input"
          value={targetDir}
          onChange={(e) => setTargetDir(e.target.value)}
          placeholder="工作区内的目录，如 D:\proj\gen"
          aria-label="生成物落盘目录"
          spellCheck={false}
        />
        <Button size="sm" variant="ghost" onClick={() => void pick()} disabled={busy}>
          选择…
        </Button>
        <label className="meta-check">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
            disabled={busy}
          />
          覆盖已有文件（先备份）
        </label>
        <Button size="sm" variant="outline" onClick={() => void run()} disabled={busy || disabled}>
          {busy ? "写入中…" : "写入磁盘"}
        </Button>
      </div>
      <p className="meta-note">
        只写 DDL / VO / UPM / 注册清单；不执行 SQL，不改 NC 安装目录。已有文件默认跳过。
      </p>

      {err && <p className="meta-error">{err}</p>}

      {result && (
        <div className="meta-export-result">
          <p>
            已写入 <strong>{result.written}</strong> 个
            {result.skipped > 0 && (
              <>
                ，跳过 <strong>{result.skipped}</strong> 个
              </>
            )}
            ：<code>{result.targetDir}</code>
          </p>
          <ul>
            {result.items.map((it) => (
              <li key={it.relPath} className={`is-${it.status}`}>
                <span>{STATUS_TEXT[it.status]}</span>
                <code>{it.relPath}</code>
                {it.status === "skipped" && <em>{it.detail}</em>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
