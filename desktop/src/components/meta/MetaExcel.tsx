import { useState } from "react";
import {
  bmfEditSave,
  bmfExcelPreview,
  bmfExcelTemplate,
  type BmfImportPreview,
  type BmfWriteResult,
} from "../../lib/bmf";
import { pickFile } from "../../lib/filePicker";
import { pickFolder, pickFolderError } from "../../lib/folderPicker";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { MetaExcelPreview } from "./MetaExcelPreview";

const suggestDir = (bmfPath: string) => {
  const dir = bmfPath.replace(/[\\/][^\\/]+$/, "");
  return dir || "";
};

/**
 * 自有模板导入 / 导出（M7）。
 *
 * 表头、语义、默认值都由本工具定义，**不是** UAP PDM 官方模板；官方格式等真实
 * 样本到位后另做适配器（届时这里会并列两个入口）。导入只预览，写入仍走受控编辑：
 * 校验 SHA、备份、原子写、给出 unified diff。
 */
export function MetaExcel({
  path,
  component,
  onEdited,
}: {
  path: string;
  component: string;
  onEdited?: () => void;
}) {
  const [dir, setDir] = useState(() => suggestDir(path));
  const [file, setFile] = useState("");
  const [busy, setBusy] = useState<null | "template" | "preview" | "save">(null);
  const [exported, setExported] = useState<string | null>(null);
  const [preview, setPreview] = useState<BmfImportPreview | null>(null);
  const [saved, setSaved] = useState<BmfWriteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pickDir = async () => {
    try {
      const picked = await pickFolder({ title: "选择模板落盘目录", defaultPath: dir || undefined });
      if (picked) setDir(picked);
    } catch (e) {
      setError(pickFolderError(e));
    }
  };

  const pickImport = async () => {
    try {
      const picked = await pickFile({
        title: "选择填好的自有模板",
        defaultPath: file || dir || undefined,
        extensions: ["xlsx"],
      });
      if (picked) {
        setFile(picked);
        setPreview(null);
        setSaved(null);
        setError(null);
      }
    } catch (e) {
      setError(`无法打开文件选择框：${e}`);
    }
  };

  const runExport = async () => {
    const target = dir.trim();
    if (!target) {
      setError("请先选择模板落盘目录");
      return;
    }
    setBusy("template");
    setError(null);
    try {
      const written = await bmfExcelTemplate(path, target);
      setExported(written);
      toast("模板已导出", "success");
    } catch (e) {
      setExported(null);
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const runPreview = async () => {
    const target = file.trim();
    if (!target) {
      setError("请先选择要导入的 .xlsx");
      return;
    }
    setBusy("preview");
    setError(null);
    setSaved(null);
    try {
      const result = await bmfExcelPreview(path, target);
      setPreview(result);
      toast(
        `预览完成：新增 ${result.add}、修改 ${result.update}、无变化 ${result.same}${result.errors ? `、错误 ${result.errors}` : ""}`,
        result.errors ? "info" : "success",
      );
    } catch (e) {
      setPreview(null);
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const write = async () => {
    if (!preview || preview.errors > 0 || preview.ops.length === 0) return;
    setBusy("save");
    setError(null);
    try {
      const result = await bmfEditSave(path, preview.ops, preview.sha256);
      setSaved(result);
      setPreview(null);
      toast(`已写入 ${preview.ops.length} 条变更`, "success");
      onEdited?.();
    } catch (e) {
      setSaved(null);
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="meta-excel">
      <section className="meta-excel-card">
        <div className="meta-excel-head">
          <h4 className="meta-section-title">
            <Icon name="download" size={13} /> 导出字段模板
          </h4>
          <span className="meta-excel-kind">自有模板 · 非官方 PDM</span>
        </div>
        <p className="meta-note m-0">
          导出当前 {component} 的实体字段，表头与默认值由 NCForge 定义；官方 PDM 模板的列名与语义不同，
          等真实样本到位后再单独适配，两者不会混用。
        </p>
        <div className="meta-export-row">
          <span className="meta-export-label">落盘到</span>
          <input
            className="meta-export-input"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="工作区内的目录"
            aria-label="模板落盘目录"
            spellCheck={false}
          />
          <Button size="sm" variant="ghost" onClick={() => void pickDir()} disabled={busy !== null}>
            选择…
          </Button>
          <Button size="sm" variant="outline" onClick={() => void runExport()} disabled={busy !== null}>
            {busy === "template" ? "导出中…" : "导出模板"}
          </Button>
        </div>
        {exported && (
          <p className="meta-note m-0">
            已导出：<code>{exported}</code>（目标已在工作区内，不覆盖同名文件）
          </p>
        )}
      </section>

      <section className="meta-excel-card">
        <div className="meta-excel-head">
          <h4 className="meta-section-title">
            <Icon name="upload" size={13} /> 导入预览
          </h4>
          <span className="meta-excel-kind">逐条 diff 后才写入</span>
        </div>
        <p className="meta-note m-0">
          选一个用自有模板填好的 .xlsx。空单元格表示不修改；新增字段默认 String / 可空。
          写入前会校验文件 SHA 并自动备份。
        </p>
        <div className="meta-export-row">
          <input
            className="meta-export-input"
            value={file}
            onChange={(e) => {
              setFile(e.target.value);
              setPreview(null);
              setSaved(null);
            }}
            placeholder="选择 .xlsx，或粘贴完整路径"
            aria-label="导入文件路径"
            spellCheck={false}
          />
          <Button size="sm" variant="ghost" onClick={() => void pickImport()} disabled={busy !== null}>
            选择文件…
          </Button>
          <Button size="sm" variant="outline" onClick={() => void runPreview()} disabled={busy !== null}>
            {busy === "preview" ? "解析中…" : "解析预览"}
          </Button>
        </div>

        {preview && (
          <MetaExcelPreview preview={preview} busy={busy === "save"} onWrite={() => void write()} />
        )}
      </section>

      {error && (
        <div className="meta-error-box">
          <strong>操作未完成</strong>
          <pre>{error}</pre>
        </div>
      )}

      {saved && (
        <div className="meta-manual">
          <div className="meta-manual-head">
            <span>写入结果</span>
            <span className="text-[11px] text-muted-foreground">
              已备份到 {saved.backup ?? "（无变更）"}
            </span>
          </div>
          <pre>{saved.diff || "（文件未变化）"}</pre>
        </div>
      )}
    </div>
  );
}
