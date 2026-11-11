import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Icon } from "../ui/icon";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { SettingsRow } from "../ui/SettingsRow";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPath } from "./SettingsPath";
import { failureText } from "../../lib/friendlyError";
import { pickFolder, pickFolderError } from "../../lib/folderPicker";
import { ncHomeCandidates, ncHomeProbe, ncHomeSet, serverStatus, type HomeCandidate, type NcHome } from "../../lib/server";
import "./settings-ncenv.css";

type EditState = {
  path: string | null; checked: NcHome | null; checking: boolean; saving: boolean;
  error: string | null; saved: string | null; confirm: boolean;
  candidates: HomeCandidate[] | null; scanning: boolean; scanError: string | null;
};
const initial: EditState = { path: null, checked: null, checking: false, saving: false, error: null, saved: null,
  confirm: false, candidates: null, scanning: false, scanError: null };
const goTab = (tab: string) => window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: tab }));

export function NcEnvSettings() {
  const qc = useQueryClient();
  const probe = useQuery({ queryKey: ["nc-home"], queryFn: () => ncHomeProbe(), staleTime: 30_000, retry: false });
  const server = useQuery({ queryKey: ["server-status"], queryFn: serverStatus, staleTime: 5_000, retry: false });
  const [edit, setEdit] = useState(initial);
  const operation = useRef(0);
  const saving = useRef(false);
  const current = probe.data?.root ?? "";
  const path = edit.path ?? current;
  const busy = edit.checking || edit.saving || edit.confirm;
  const running = server.data?.state === "running" || server.data?.state === "starting";
  const choose = (next: string) => {
    ++operation.current;
    setEdit(prev => ({ ...prev, path: next, checked: null, error: null, saved: null, checking: false }));
  };
  const reset = () => { ++operation.current; setEdit(prev => ({ ...prev, path: null, checked: null, error: null, saved: null, checking: false })); };
  const browse = async () => {
    try {
      const selected = await pickFolder({ title: "选择 NC 安装目录（含 ufjdk、modules 的那一层）", defaultPath: path || undefined });
      if (selected) choose(selected);
    } catch (e) { setEdit(prev => ({ ...prev, error: pickFolderError(e) })); }
  };
  const check = async () => {
    if (!path.trim()) { setEdit(prev => ({ ...prev, error: "请输入或选择 NC 安装目录。" })); return; }
    const token = ++operation.current;
    setEdit(prev => ({ ...prev, checking: true, checked: null, error: null, saved: null }));
    try {
      const checked = await ncHomeProbe(path.trim());
      if (token === operation.current) setEdit(prev => ({ ...prev, checked, checking: false }));
    } catch (e) {
      if (token === operation.current) setEdit(prev => ({ ...prev, checking: false, error: failureText("检测目录", e) }));
    }
  };
  const commit = async () => {
    if (!edit.checked || saving.current) return;
    saving.current = true;
    setEdit(prev => ({ ...prev, confirm: false, saving: true, error: null }));
    try {
      const home = await ncHomeSet(edit.checked.root);
      qc.setQueryData(["nc-home"], home);
      setEdit(prev => ({ ...prev, path: null, checked: null, saved: "NC 安装目录已保存。正在运行的服务继续使用启动时的目录，新目录在下次启动服务时生效。" }));
      void qc.invalidateQueries({ queryKey: ["server-status"] });
      void qc.invalidateQueries({ queryKey: ["patch-defaults"] });
    } catch (e) { setEdit(prev => ({ ...prev, error: failureText("保存 NC 安装目录", e) })); }
    finally { saving.current = false; setEdit(prev => ({ ...prev, saving: false })); }
  };
  const save = async () => {
    if (!edit.checked || busy || saving.current) return;
    // Refresh before switching: a stale stopped snapshot must not bypass confirmation.
    saving.current = true;
    setEdit(prev => ({ ...prev, saving: true, error: null }));
    try {
      const status = await server.refetch();
      if (status.error || !status.data) throw status.error ?? new Error("服务状态未知，请重试。");
      saving.current = false;
      setEdit(prev => ({ ...prev, saving: false }));
      if (status.data.state !== "stopped") setEdit(prev => ({ ...prev, confirm: true }));
      else await commit();
    } catch (e) {
      saving.current = false;
      setEdit(prev => ({ ...prev, saving: false, error: failureText("确认服务状态", e) }));
    }
  };
  const scan = async () => {
    setEdit(prev => ({ ...prev, scanning: true, scanError: null }));
    try { const candidates = await ncHomeCandidates(); setEdit(prev => ({ ...prev, candidates })); }
    catch (e) { setEdit(prev => ({ ...prev, scanError: failureText("扫描常见位置", e) })); }
    finally { setEdit(prev => ({ ...prev, scanning: false })); }
  };

  return <>
    <SettingsRow id="nc-home-current" label="当前配置目录" keywords={["NC", "home", "安装目录", "路径"]}
      sub={probe.isLoading ? "正在识别当前配置…" : probe.error ? failureText("识别当前配置", probe.error) : probe.data?.root ? `${probe.data.moduleCount} 个模块 · ${probe.data.hasNcStarter ? "完整安装" : "无 startup.bat"} · ${probe.data.httpPort ? `端口 ${probe.data.httpPort}` : "端口未识别"}` : "未配置，请在下方选择目录。"}
      valueText={current || "未配置"} layout="stack" control={<div className="settings-form-actions"><SettingsPath value={current} label="NC 配置目录" empty="未配置" />{probe.error && <Button size="sm" variant="outline" onClick={() => void probe.refetch()}>重试识别</Button>}</div>} />
    <SettingsRow id="nc-home-service" label="当前服务目录" valueText={server.isLoading ? "读取中" : server.error ? "读取失败" : running ? server.data?.ncHome ?? "运行目录未知" : "服务未运行"}
      sub={server.error ? failureText("读取服务状态", server.error) : running ? `正在使用：${server.data?.ncHome ?? "运行目录未知"}；切换配置后需要重新启动服务。` : "下次启动服务时使用配置目录。"}
      control={<div className="settings-form-actions">{running && server.data?.ncHome && <SettingsPath value={server.data.ncHome} label="当前服务目录" />}<Button size="sm" variant="ghost" onClick={() => server.error ? void server.refetch() : goTab("services")}>{server.error ? "重试读取" : "查看 NC 服务"}</Button></div>} />
    <SettingsRow id="nc-home-path" controlId="nc-home-input" label="选择安装目录" keywords={["更改", "浏览", "检测", "NC65", "ufjdk"]}
      sub="选择包含 ufjdk、modules、middleware 的那一层。浏览与候选选择只填写草稿，检测通过后再保存。"
      valueText={current || "未配置"} layout="stack" error={edit.error ?? undefined}
      control={<div className="settings-ncenv-editor">
        <div className="settings-ncenv-path"><Input id="nc-home-input" aria-label="NC 安装目录" value={path} spellCheck={false}
          placeholder="输入 NC 安装目录" disabled={edit.saving || edit.confirm}
          onChange={e => choose(e.target.value)} aria-invalid={!!edit.error}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing || busy) return;
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); reset(); }
            if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void (edit.checked ? save() : check()); }
          }} />
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void browse()}><Icon name="folder" size={14} />浏览…</Button>
        </div>
        <div className="settings-form-actions">
          <Button size="sm" variant="outline" disabled={busy} isLoading={edit.checking} loadingText="检测中…" onClick={() => void check()}>检测目录</Button>
          <Button size="sm" disabled={!edit.checked || busy} isLoading={edit.saving} loadingText="保存中…" onClick={() => void save()}>保存并使用</Button>
          {edit.path !== null && <Button size="sm" variant="ghost" disabled={edit.saving || edit.confirm} onClick={reset}>取消修改</Button>}
        </div>
        <p className="settings-help" role="status">{edit.saved ?? (edit.checked ? "检测通过，确认后保存并使用。" : "请先检测目录，再保存。")}</p>
        {edit.checked && <div className="settings-ncenv-detection" aria-label="目录检测结果">
          <p><Icon name="check" size={14} />目录识别通过 · {edit.checked.moduleCount} 个模块</p>
          <p>Java：<code>{edit.checked.java}</code></p>
          <p>启动文件：{edit.checked.hasNcStarter ? "startup.bat 已找到" : "无 startup.bat，部分启动方式可能不可用"}</p>
          <p>中间件端口：{edit.checked.httpPort ?? "未读到配置，服务将按默认端口处理"}</p>
        </div>}
      </div>} />
    <SettingsGroup title="自动发现目录" summary={edit.candidates ? `${edit.candidates.length} 个候选` : "扫描常见位置"} defaultOpen={!current}>
      <SettingsRow id="nc-home-scan" label="扫描常见位置" keywords={["自动探测", "候选", "搜索目录"]}
        sub="扫描硬盘根目录及工作区同级目录；候选需要再检测确认。" valueText={edit.scanning ? "扫描中" : edit.candidates ? `${edit.candidates.length} 个候选` : "尚未扫描"}
        error={edit.scanError ?? undefined} control={<Button size="sm" variant="outline" disabled={edit.scanning || busy} isLoading={edit.scanning} loadingText="扫描中…" onClick={() => void scan()}>扫描常见位置</Button>} />
      {edit.candidates?.length === 0 && <p className="settings-help" role="status">没有找到候选。请使用上方“浏览”或手动输入目录。</p>}
      {!!edit.candidates?.length && <div className="settings-ncenv-cands" role="list" aria-label="扫描到的候选">
        {edit.candidates.map(candidate => <div key={candidate.root} className="settings-ncenv-cand" role="listitem">
          <div className="settings-ncenv-cand-main"><code>{candidate.root}</code><span className="settings-help">{candidate.moduleCount} 个模块 · {candidate.source === "driveRoot" ? "硬盘目录" : "工作区同级"}</span></div>
          <Button size="sm" variant="outline" disabled={busy || candidate.root === current} onClick={() => choose(candidate.root)}>{candidate.root === current ? "当前配置" : "选择目录"}</Button>
        </div>)}
      </div>}
    </SettingsGroup>
    <SettingsRow id="nc-home-database" label="相关配置：数据库连接" sub="数据库连接在数据库页管理，不参与安装目录识别。" last
      control={<Button size="sm" variant="ghost" onClick={() => goTab("db")}>管理数据库连接</Button>} />
    <ConfirmDialog open={edit.confirm} title="保存新的 NC 安装目录？"
      description="当前服务仍使用启动时的目录。本次只保存配置，服务下次启动时使用新目录；现在的服务不会被停止。"
      confirmLabel="保存配置，稍后重启" onCancel={() => setEdit(prev => ({ ...prev, confirm: false }))} onConfirm={() => void commit()} />
  </>;
}
