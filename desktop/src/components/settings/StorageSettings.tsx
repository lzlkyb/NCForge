import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Icon, type IconName } from "../ui/icon";
import { ToggleRow } from "../ui/ToggleRow";
import { useOperationById, useOperation } from "../../lib/operations";
import { formatBytes } from "../../lib/utils";
import { failureText } from "../../lib/friendlyError";
import { requestSettingItem, requestSettingsSection } from "../../lib/settingsJump";
import {
  applyStorage, autoStorageEnabled, currentStorageUsage, previewStorage, setAutoStorage, storageReceipt,
  type StorageCategory, type StoragePreview, type StorageReport, type StorageScope, type StorageUsage,
} from "../../lib/storageMaintenance";
import { StorageMemory } from "./StorageMemory";
import "./storage-settings.css";

const categories: Record<StorageCategory, { label: string; detail: string; icon: IconName }> = {
  temporary: { label: "临时文件与日志", detail: "编译临时文件与应用日志", icon: "log" },
  cache: { label: "可重建缓存", detail: "代码智能索引与构建缓存", icon: "layers" },
  components: { label: "运行组件与界面数据", detail: "按需组件、界面存储和更新文件", icon: "package" },
  local: { label: "其他本地数据", detail: "配置、本地历史与用户资料", icon: "shield" },
};

const kinds = { compile: "编译残留", download: "下载残留", log: "旧日志", language: "代码智能索引" };
const reasons = { changed: "文件已变化或正在使用", unsafe: "目录归属已变化", access: "权限不足", busy: "文件无法移除" };
const sizeText = (bytes: number | null | undefined) => bytes == null ? "暂不可用" : formatBytes(bytes);
type PreviewState = { scope: StorageScope; data: StoragePreview; excluded: number[] };
type DiskState = { usage?: StorageUsage; estimate?: StoragePreview; preview?: PreviewState; report?: StorageReport;
  error?: string; busy?: "scan" | "preview" | "apply" };

export function StorageSettings({ active }: { active: boolean }) {
  const [{ view, memoryVisited }, setView] = useState<{ view: "disk" | "memory"; memoryVisited: boolean }>({ view: "disk", memoryVisited: false });
  return <div className="storage-settings">
    <nav className="storage-nav" aria-label="资源类型">
      <Button size="sm" variant={view === "disk" ? "secondary" : "ghost"} aria-pressed={view === "disk"}
        onClick={() => setView(current => ({ ...current, view: "disk" }))}><Icon name="database" size={15} aria-hidden="true" />磁盘空间</Button>
      <Button size="sm" variant={view === "memory" ? "secondary" : "ghost"} aria-pressed={view === "memory"}
        onClick={() => setView({ view: "memory", memoryVisited: true })}><Icon name="activity" size={15} aria-hidden="true" />运行内存</Button>
    </nav>
    <div hidden={view !== "disk"}><StorageDisk active={active && view === "disk"} /></div>
    {memoryVisited && <div hidden={view !== "memory"}><StorageMemory active={active && view === "memory"} /></div>}
  </div>;
}

async function scanDisk(): Promise<{ usage: StorageUsage; estimate: StoragePreview }> {
  const usage = await currentStorageUsage();
  const estimate = await previewStorage("recommended");
  return { usage, estimate };
}

function StorageDisk({ active }: { active: boolean }) {
  const [state, setState] = useState<DiskState>({});
  const [auto, setAuto] = useState(() => autoStorageEnabled());
  const initialized = useRef(false);
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
  const operation = useOperation("storage.cleanup");
  const busy = Boolean(state.busy || (operation && operation.endedAt === undefined));
  // Settings sections stay mounted for search. Start the first scan only when this one is visible.
  useEffect(() => {
    if (!active || initialized.current) return;
    initialized.current = true;
    setState(current => ({ ...current, busy: "scan" }));
    void scanDisk().then(data => setState(current => ({ ...current, ...data, busy: undefined })),
      error => setState(current => ({ ...current, busy: undefined, error: failureText("读取本机存储", error) })));
  }, [active]);

  const refresh = async (report?: StorageReport) => {
    setState(current => ({ ...current, busy: "scan", preview: undefined, error: undefined, report }));
    try {
      const data = await scanDisk();
      setState(current => ({ ...current, ...data, busy: undefined }));
    } catch (error) {
      setState(current => ({ ...current, busy: undefined, error: failureText("读取本机存储", error) }));
    }
  };

  const showPreview = async (scope: StorageScope, trigger: HTMLButtonElement) => {
    previewTrigger.current = trigger;
    setState(current => ({ ...current, busy: "preview", error: undefined, report: undefined, preview: undefined }));
    try {
      const data = await previewStorage(scope);
      setState(current => ({ ...current, busy: undefined, preview: { scope, data, excluded: scope === "language" ? data.entries.map(entry => entry.key) : [] },
        estimate: scope === "recommended" ? data : current.estimate }));
    } catch (error) {
      setState(current => ({ ...current, busy: undefined, error: failureText("生成清理预览", error) }));
    }
  };

  const clean = async (preview: PreviewState, selected: number[]) => {
    setState(current => ({ ...current, busy: "apply", error: undefined, preview: undefined }));
    try { await refresh(await applyStorage(preview.data.id, selected)); }
    catch (error) {
      setState(current => ({ ...current, busy: undefined, error: failureText("清理存储，请重新预览后再试", error) }));
    }
  };

  const { usage, estimate, preview, report } = state;
  const partial = usage && Object.values(usage.categories).some(category => category.incomplete);
  const total = usage && Object.values(usage.categories).reduce((sum, category) => sum + category.bytes, 0);
  const estimated = estimate?.entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const storageRows = (Object.keys(categories) as StorageCategory[])
    .sort((a, b) => (usage?.categories[b].bytes ?? 0) - (usage?.categories[a].bytes ?? 0));

  return <>
    <div className="storage-toolbar">
      <h2>本机存储</h2>
      <Button size="sm" variant="ghost" isLoading={state.busy === "scan"} disabled={busy} onClick={() => void refresh()}>
        <Icon name="refresh" size={14} aria-hidden="true" />重新扫描
      </Button>
    </div>
    <div className="storage-overview">
      <dl className="storage-summary">
        <div className="storage-clean-metric"><dt>预计可清理</dt>
          <dd>{sizeText(estimated)}{estimate?.entries.length ? <small>{estimate.entries.length} 项</small> : null}</dd>
        </div>
        <div><dt>已统计占用</dt><dd>{sizeText(total)}{partial && <small>部分</small>}</dd></div>
        <div><dt>所在磁盘可用</dt><dd>{sizeText(usage?.freeBytes)}</dd></div>
      </dl>
      <Button size="sm" variant={preview ? "outline" : "default"} disabled={busy}
        onClick={event => void showPreview("recommended", event.currentTarget)}>
        <Icon name="trash" size={14} aria-hidden="true" />建议清理
      </Button>
    </div>
    {partial && <p className="storage-note">部分项目无法读取或超出本次扫描范围，已显示可确认的占用。</p>}
    {usage?.freeBytes != null && usage.freeBytes < 1024 ** 3 && <p className="storage-note" role="status">磁盘可用空间低于 1 GB，可先查看建议清理项。</p>}
    {state.busy === "scan" && <p className="storage-note" role="status">正在统计本机文件，可以继续使用工作台。</p>}
    {state.error && <p className="settings-inline-error" role="alert">{state.error}</p>}
    {report && <div className="storage-receipt" role="status">
      <Icon name={report.skipped ? "alert" : report.cancelled ? "stop" : "check"} size={16} aria-hidden="true" />
      <div><strong>{report.cancelled ? "已停止清理" : "清理结果"}</strong>
        <span>{storageReceipt(report)}{Object.entries(report.reasons).map(([reason, count]) => ` · ${reasons[reason as keyof typeof reasons]} ${count} 项`)}</span>
      </div>
    </div>}
    {state.busy === "apply" && <StorageProgress operationId={operation?.id} />}
    {state.busy === "preview" && <p className="storage-note" role="status">正在准备清理清单…</p>}
    {preview && <CleanupPreview preview={preview} onCancel={() => {
      setState(current => ({ ...current, preview: undefined }));
      previewTrigger.current?.focus({ preventScroll: true });
    }}
      onToggle={key => setState(current => current.preview ? { ...current, preview: { ...current.preview,
        excluded: current.preview.excluded.includes(key) ? current.preview.excluded.filter(value => value !== key) : [...current.preview.excluded, key],
      } } : current)} onApply={selected => void clean(preview, selected)} />}
    <section className="storage-breakdown" aria-label="占用分类">
      <h3>占用分类</h3>
      {usage && !!total && <div className="storage-composition" aria-hidden="true">
        {storageRows.filter(key => usage.categories[key].bytes > 0).map(key =>
          <span key={key} data-category={key} style={{ flexGrow: usage.categories[key].bytes / total }}
            title={`${categories[key].label} · ${sizeText(usage.categories[key].bytes)}`} />)}
      </div>}
      <ul className="storage-category-list">
        {storageRows.map(key => {
          const format = usage?.categories[key];
          const { label, detail, icon } = categories[key];
          return <li className="storage-category" key={key}>
            <span className="storage-category-mark" data-category={key} aria-hidden="true" />
            <Icon name={icon} size={17} aria-hidden="true" />
            <div className="storage-item-name"><strong>{label}</strong><small>{detail}</small></div>
            <strong className="storage-category-value">{sizeText(format?.bytes)}{format?.incomplete && <small>部分</small>}</strong>
            {key === "cache" && <div className="storage-category-actions">
              <Button size="sm" variant="outline" disabled={busy || !usage || usage.languageBusy}
                title={usage?.languageBusy ? "代码智能正在使用索引，停止后重新扫描" : undefined}
                onClick={event => void showPreview("language", event.currentTarget)}>查看可重建索引</Button>
              <Button size="sm" variant="ghost" onClick={() => requestSettingItem("编译与热替换", "build-cache")}>编译缓存</Button>
            </div>}
            {key === "components" && <div className="storage-category-actions"><Button size="sm" variant="ghost"
              onClick={() => requestSettingsSection("软件与组件")}>管理组件<Icon name="chevronRight" size={13} aria-hidden="true" /></Button></div>}
          </li>;
        })}
      </ul>
    </section>
    <div className="storage-policy">
      <ToggleRow id="storage-auto-cleanup" label="空闲时自动清理" checked={auto}
        sub="处理超过 7 天的闲置残留"
        info="只处理已识别的编译残留、失败下载和旧日志。配置、运行组件、SQL 记录和本地历史会保留。"
        onChange={next => { setAutoStorage(next); setAuto(next); }} last />
    </div>
  </>;
}

function CleanupPreview({ preview, onCancel, onToggle, onApply }: {
  preview: PreviewState; onCancel: () => void; onToggle: (key: number) => void; onApply: (keys: number[]) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = panel.current;
    if (!element || element.closest("[hidden]")) return;
    element.focus({ preventScroll: true });
    element.scrollIntoView?.({ block: "nearest" });
  }, []);
  const selected = preview.data.entries.filter(entry => !preview.excluded.includes(entry.key));
  const bytes = selected.reduce((sum, entry) => sum + entry.bytes, 0);
  return <section className="storage-preview" ref={panel} tabIndex={-1} aria-label="清理预览" onKeyDown={event => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onCancel();
  }}>
    <div className="storage-toolbar storage-preview-heading">
      <h3><Icon name="clipboard" size={17} aria-hidden="true" />清理预览</h3>
      <span>已选 <strong>{selected.length}</strong> 项<span aria-hidden="true"> · </span>预计释放 <strong>{formatBytes(bytes)}</strong></span>
    </div>
    {preview.scope === "language" && <p className="storage-note">清理所选项目后，下次使用相应工作区或模块会重新建立索引。活动源码与构建产物会保留。</p>}
    {preview.data.incomplete && <p className="storage-note">本次只列出可确认的项目，可在清理后重新扫描。</p>}
    {preview.data.entries.length ? <ul className="storage-preview-list">
      {preview.data.entries.map(entry => <li key={entry.key}><label>
        <input type="checkbox" checked={!preview.excluded.includes(entry.key)} onChange={() => onToggle(entry.key)} />
        <span><strong>{entry.workspace || kinds[entry.kind]}</strong>
          <small title={entry.name}>{entry.lastUsed ? `上次使用 ${new Date(entry.lastUsed).toLocaleString()}` : entry.name}</small>
        </span>
        <span>{formatBytes(entry.bytes)}</span>
      </label></li>)}
    </ul> : <p className="storage-note" role="status">没有符合条件的清理项。</p>}
    <div className="storage-row-actions storage-preview-footer">
      <Button size="sm" variant="ghost" onClick={onCancel}>关闭预览</Button>
      <Button size="sm" disabled={!selected.length} onClick={() => onApply(selected.map(entry => entry.key))}>清理所选</Button>
    </div>
  </section>;
}

function StorageProgress({ operationId }: { operationId?: number }) {
  const task = useOperationById(operationId);
  const progress = task?.progress;
  return <p className="storage-note" role="status">{progress?.total ? `已处理 ${progress.done} / ${progress.total} 项` : "正在复核清理清单…"} · 可在任务区查看或停止</p>;
}
