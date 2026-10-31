import { useRef, useState } from "react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Modal } from "../ui/Modal";
import { SettingsRow } from "../ui/SettingsRow";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
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
  const [exporting, setExporting] = useState(false);
  /** 待确认的导入：原始导出对象 + 预览模型 + 路径编辑值。 */
  const [pending, setPending] = useState<{
    data: ConfigExport;
    plan: ImportPlan;
    edits: Partial<Record<PathFieldKey, string>>;
  } | null>(null);
  const [importing, setImporting] = useState(false);

  const doExport = async () => {
    setExporting(true);
    try {
      await downloadConfigExport();
      toast("配置已导出，把文件发给同事即可（不含任何口令）", "success");
    } catch (e) {
      toast(`导出失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setExporting(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch (e) {
      toast(`读取文件失败：${e instanceof Error ? e.message : String(e)}`, "error");
      return;
    }
    const parsed = parseExportFile(text);
    if (!parsed.ok) {
      toast(parsed.error, "error");
      return;
    }
    const plan = buildImportPlan(parsed.data);
    if (plan.pathItems.length === 0 && plan.connCount === 0 && !plan.hasHeap && !plan.hasSvnUser) {
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
    if (!pending) return;
    setImporting(true);
    try {
      await importConfig(withPathEdits(pending.data, pending.edits));
      toast("配置已导入。数据库 / SVN 口令需在本机重新输入后才能使用", "success");
      setPending(null);
      onChanged?.();
    } catch (e) {
      toast(`导入失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setImporting(false);
    }
  };

  return (
    <Card className="flex flex-col gap-1 p-2">
      <div className="px-2 pt-2">
        <div className="text-sm font-medium">配置迁移</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          把调好的设置打包发给同事，或从同事那里导入。换机器 / 重装系统同样适用。
        </div>
      </div>
      <SettingsRow
        label="导出配置"
        sub="生成本机设置的 JSON 文件（数据库 / SVN 口令不含在内）"
        control={
          <Button variant="outline" size="sm" disabled={exporting} onClick={() => void doExport()}>
            {exporting ? "导出中…" : "导出"}
          </Button>
        }
      />
      <SettingsRow
        label="导入配置"
        sub="选择同事给的 JSON 文件；路径类设置可在导入前改写"
        last
        control={
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            选择文件
          </Button>
        }
      />
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
        onClose={() => setPending(null)}
        ariaLabel="导入配置预览"
        className="modal-surface"
      >
        {pending && (
          <div className="flex max-h-[70vh] w-[min(560px,90vw)] flex-col gap-3 overflow-y-auto p-5">
            <h2 className="text-base font-medium">导入配置</h2>
            <p className="text-xs text-muted-foreground">
              来自工作台{pending.plan.fromVersion ? ` v${pending.plan.fromVersion}` : "（版本未知）"}
              的配置文件。确认下面各项后导入；**没有出现的设置保持本机原值**。
            </p>

            {pending.plan.pathItems.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="text-sm font-medium">路径设置（已按导入机器改写）</div>
                {pending.plan.pathItems.map((item) => (
                  <label key={item.key} className="flex flex-col gap-0.5">
                    <span className="text-xs text-muted-foreground">
                      {item.label} · {item.hint}
                    </span>
                    <input
                      className="rounded border bg-background px-2 py-1 text-sm"
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

            <div className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
              <Icon name="info" size={13} aria-hidden="true" />
              <span className="text-xs">
                口令不随配置导入：数据库 / SVN 密码只存本机，导入后需在新机器上重新输入一次。
              </span>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPending(null)}>
                取消
              </Button>
              <Button size="sm" disabled={importing} onClick={() => void confirmImport()}>
                {importing ? "导入中…" : "确认导入"}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}
