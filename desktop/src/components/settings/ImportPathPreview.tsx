import { useEffect, useRef, useState } from "react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { exportConfig, parseExportFile, type ExportableConfig, type ImportPlan, type PathFieldKey } from "../../lib/configTransfer";
import { listDir } from "../../lib/workspace";
import { ncHomeProbe } from "../../lib/server";
import { failureText } from "../../lib/friendlyError";

export function ImportPathPreview({ plan, edits, disabled, idPrefix, onEdit }: {
  plan: ImportPlan; edits: Partial<Record<PathFieldKey, string>>; disabled: boolean; idPrefix: string;
  onEdit: (key: PathFieldKey, value: string) => void;
}) {
  const [current, setCurrent] = useState<{ config?: ExportableConfig; error?: string }>({});
  const [checks, setChecks] = useState<Partial<Record<PathFieldKey, { value: string; text: string; pending?: boolean; failed?: boolean }>>>({});
  const revision = useRef({ active: true });
  const requests = useRef<Partial<Record<PathFieldKey, number>>>({});
  useEffect(() => {
    const lifetime = { active: true };
    revision.current = lifetime;
    let alive = true;
    exportConfig().then(json => {
      const parsed = parseExportFile(json);
      if (alive) setCurrent(parsed.ok ? { config: parsed.data.config } : { error: parsed.error });
    }, () => { if (alive) setCurrent({ error: "本机值读取失败，请核对导入内容。" }); });
    return () => { alive = false; lifetime.active = false; };
  }, []);
  const check = async (key: PathFieldKey) => {
    const value = (edits[key] ?? "").trim();
    const version = revision.current;
    const request = (requests.current[key] ?? 0) + 1;
    requests.current[key] = request;
    setChecks(prev => ({ ...prev, [key]: { value, text: "检测中…", pending: true } }));
    try {
      if (!value) throw new Error("空路径不会导入该字段，请核对是否需要填写。");
      if (key === "nc_home") await ncHomeProbe(value);
      else await listDir(value);
      if (version.active && requests.current[key] === request) setChecks(prev => ({ ...prev, [key]: { value, text: key === "nc_home" ? "NC 目录识别通过" : "目录可读取" } }));
    } catch (e) {
      if (version.active && requests.current[key] === request) setChecks(prev => ({ ...prev, [key]: { value, text: failureText("检测路径", e), failed: true } }));
    }
  };
  return <div className="settings-import-paths">
    <h3>路径设置 · 请调整为本机路径</h3>
    {current.error && <p className="settings-inline-error" role="alert">{current.error}</p>}
    {plan.pathItems.map(item => {
      const checkState = checks[item.key]?.value === (edits[item.key] ?? "").trim() ? checks[item.key] : undefined;
      return <div key={item.key} className="settings-import-path">
        <label htmlFor={`${idPrefix}-${item.key}`}>{item.label}<span className="settings-help"> · {item.hint}</span></label>
        <p className="settings-help">本机值：<code>{current.config ? current.config[item.key] ?? "未设置" : current.error ? "未知" : "读取中…"}</code></p>
        <div className="settings-form-actions"><Input id={`${idPrefix}-${item.key}`} disabled={disabled} spellCheck={false} value={edits[item.key] ?? ""}
          aria-label={`导入${item.label}`} onChange={e => {
            // 作废在途检测时也要把那条 pending 记录清掉：`checkState` 只按值相等匹配，
            // 用户改了再改回原值就会重新配上「检测中…」，按钮从此永久禁用。
            requests.current[item.key] = (requests.current[item.key] ?? 0) + 1;
            setChecks(prev => ({ ...prev, [item.key]: undefined }));
            onEdit(item.key, e.target.value);
          }} />
          <Button size="sm" variant="outline" disabled={disabled || checkState?.pending} isLoading={checkState?.pending} onClick={() => void check(item.key)}>检测路径</Button></div>
        <p className={checkState?.failed ? "settings-inline-error" : "settings-help"} role={checkState?.failed ? "alert" : "status"}>{checkState?.text ?? "尚未检测 · 确认前请核对路径"}</p>
      </div>;
    })}
  </div>;
}
