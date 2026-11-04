import { useId, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Modal } from "../ui/Modal";
import { SettingsRow } from "../ui/SettingsRow";
import { Input } from "../ui/input";
import { InlineNotice } from "../ui/notice";
import { toast } from "../ui/toast";
import { trackOperation } from "../../lib/operations";
import { errorTextOf, failureText } from "../../lib/friendlyError";
import {
  buildImportPlan,
  downloadConfigExport,
  importConfig,
  parseExportFile,
  withPathEdits,
  type ConfigExport,
  type ImportPlan,
  type PathFieldKey,
} from "../../lib/configTransfer";
import "./settings-maintenance.css";

/**
 * 「配置迁移」卡（M8 团队化）：导出 / 导入配置。
 *
 * 分工：**口令不随配置走**（DPAPI 只存本机，导出物里没有口令字段）——
 * 导入预览里对这点有固定提示，别让用户以为导入完就能连数据库。
 * 路径类字段（工作区 / NC home / 补丁目录）在预览里可逐条改写：
 * 导出的是导出机器的绝对路径，换机器后大概率不存在。
 */
export function ConfigTransferSettings({ onChanged }: { onChanged?: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const pathId = useId();
  const [exporting, setExporting] = useState(false);
  const [reading, setReading] = useState(false);
  const lock = useRef(false);
  const [feedback, setFeedback] = useState<{ kind: "export" | "import"; error: string } | null>(null);
  /** 待确认的导入：原始导出对象 + 预览模型 + 路径编辑值。 */
  const [pending, setPending] = useState<{
    data: ConfigExport;
    plan: ImportPlan;
    edits: Partial<Record<PathFieldKey, string>>;
  } | null>(null);
  const [importing, setImporting] = useState(false);

  const doExport = async () => {
    if (lock.current) return;
    lock.current = true;
    setFeedback(null);
    setExporting(true);
    try {
      await downloadConfigExport();
      toast("配置已导出，把文件发给同事即可（不含任何口令）", "success");
    } catch (e) {
      const error = failureText("导出配置", e);
      setFeedback({ kind: "export", error });
      toast(error, "error");
    } finally {
      lock.current = false;
      setExporting(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file || lock.current) return;
    lock.current = true;
    setReading(true);
    setFeedback(null);
    let text: string;
    try {
      text = await trackOperation({ key: "settings.import.read", label: "读取配置文件", page: "settings" }, () => file.text());
    } catch (e) {
      const error = `读取文件失败：${errorTextOf(e)}`;
      setFeedback({ kind: "import", error });
      toast(error, "error");
      return;
    } finally { lock.current = false; setReading(false); }
    const parsed = parseExportFile(text);
    if (!parsed.ok) {
      setFeedback({ kind: "import", error: parsed.error });
      toast(parsed.error, "error");
      return;
    }
    const plan = buildImportPlan(parsed.data);
    if (plan.pathItems.length === 0 && plan.connCount === 0 && !plan.hasHeap && !plan.hasSvnUser) {
      setFeedback({ kind: "import", error: "文件里没有可导入的设置" });
      toast("文件里没有可导入的设置", "error");
      return;
    }
    setPending({
      data: parsed.data,
      plan,
      edits: Object.fromEntries(plan.pathItems.map((p) => [p.key, p.value])),
    });
  };

  const confirmImport = async () => {
    if (!pending || lock.current) return;
    lock.current = true;
    setFeedback(null);
    setImporting(true);
    try {
      await importConfig(withPathEdits(pending.data, pending.edits));
      toast("配置已导入。数据库 / SVN 口令需在本机重新输入后才能使用", "success");
      setPending(null);
      onChanged?.();
    } catch (e) {
      const error = failureText("导入配置", e);
      setFeedback({ kind: "import", error });
      toast(error, "error");
    } finally {
      lock.current = false;
      setImporting(false);
    }
  };

  return (
    <Card className="settings-maintenance-section">
      <SettingsRow
        id="transfer-export"
        label="导出配置"
        keywords={["备份", "JSON", "迁移", "分享配置"]}
        sub="生成可迁移的 JSON 文件"
        info="导出工作区、NC 路径、数据库连接等可迁移配置。数据库与 SVN 密码不包含在文件中。外观和编辑器阅读偏好只保存在本机。"
        valueText={exporting ? "正在导出" : "JSON 文件"}
        error={feedback?.kind === "export" ? feedback.error : undefined}
        control={
          <Button variant="outline" size="sm" isLoading={exporting} loadingText="导出中…" disabled={exporting || importing || reading} onClick={() => void doExport()}>
            {exporting ? "导出中…" : "导出"}
          </Button>
        }
      />
      <SettingsRow
        id="transfer-import"
        label="导入配置"
        keywords={["恢复", "JSON", "迁移", "配置文件"]}
        sub="选择文件，预览并调整路径后确认导入"
        valueText={pending ? "待确认" : "选择 JSON 文件"}
        error={feedback?.kind === "import" ? feedback.error : undefined}
        last
        control={
          <Button variant="outline" size="sm" isLoading={reading} loadingText="读取中…" disabled={importing || exporting || reading} onClick={() => fileRef.current?.click()}>
            选择文件
          </Button>
        }
      />
      <p className="settings-maintenance-footnote">数据库与 SVN 密码只存本机，迁移后需要重新输入。</p>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        aria-label="选择配置文件"
        onChange={(e) => {
          // 先清 value：同一个文件再选一次时 change 不触发，用户会以为按钮坏了
          const f = e.target.files?.[0];
          e.target.value = "";
          void onFile(f);
        }}
      />

      <Modal
        open={pending !== null}
        onClose={() => { if (!importing) setPending(null); }}
        ariaLabel="导入配置预览"
        className="modal-surface"
      >
        {pending && (
          <div className="settings-import-preview">
            <h2 className="text-base font-medium">导入配置</h2>
            <p className="text-xs text-muted-foreground">
              来自工作台{pending.plan.fromVersion ? ` v${pending.plan.fromVersion}` : "（版本未知）"}
              的配置文件。确认下面各项后导入；<b className="text-foreground">没有出现的设置保持本机原值</b>。
            </p>

            {pending.plan.pathItems.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="text-sm font-medium">路径设置（已按导入机器改写）</div>
                {pending.plan.pathItems.map((item) => (
                  <label key={item.key} htmlFor={`${pathId}-${item.key}`} className="flex flex-col gap-0.5">
                    <span className="text-xs text-muted-foreground">
                      {item.label} · {item.hint}
                    </span>
                    <Input
                      id={`${pathId}-${item.key}`}
                      disabled={importing}
                      spellCheck={false}
                      value={pending.edits[item.key] ?? ""}
                      onChange={(e) =>
                        setPending({
                          ...pending,
                          edits: { ...pending.edits, [item.key]: e.target.value },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            )}

            {pending.plan.connCount > 0 && (
              <div className="flex flex-col gap-1">
                <div className="text-sm font-medium">数据库连接（{pending.plan.connCount} 条）</div>
                <ul className="flex flex-col gap-0.5 pl-4">
                  {pending.plan.connNames.map((n, i) => (
                    <li key={i} className="text-xs text-muted-foreground">
                      {n}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <InlineNotice variant="warning">
                口令不随配置导入：数据库 / SVN 密码只存本机，导入后需在新机器上重新输入一次。
            </InlineNotice>
            {feedback?.kind === "import" && <p className="settings-import-error" role="alert">{feedback.error}</p>}

            <div className="settings-maintenance-actions">
              <Button variant="ghost" size="sm" disabled={importing} onClick={() => setPending(null)}>
                取消
              </Button>
              <Button size="sm" isLoading={importing} loadingText="导入中…" disabled={importing} onClick={() => void confirmImport()}>
                {importing ? "导入中…" : "确认导入"}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}
