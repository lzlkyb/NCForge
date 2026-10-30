import { useState } from "react";
import { Icon } from "../ui/icon";
import { settle, type Pending, type SaveFailure } from "../../lib/dbConfirm";

/**
 * 退出前的未保存文件确认（`DbConfirmHost` 的一个弹框体，单独成文件是因为它
 * 自带三态机，把宿主撑破了 300 行的体量门禁）。
 *
 * **要列文件名，不能只说「有 3 个文件未保存」**：那句等于没给信息，手指一快就点了
 * 「不保存」。列出来用户才认得出是哪个文件、值不值得留。
 *
 * 三态：idle 选择 → saving 显示进度 → failed 就地列出失败原因。
 * 保存失败时**不关框**：关掉让用户自己去猜哪个文件出问题，等于把一次可挽回的
 * 错误变成数据丢失。进度显示也是必需的——文件多时按钮没反应，用户会以为卡死，
 * 再点一次 X（那次会被后端当成连点忽略，但人只会更慌）。
 */
export function FilesBody({ p }: { p: Extract<Pending, { kind: "unsavedFiles" }> }) {
  const [phase, setPhase] = useState<"idle" | "saving" | "failed">("idle");
  const [progress, setProgress] = useState({ done: 0, total: p.files.length });
  const [failed, setFailed] = useState<SaveFailure[]>([]);

  const saveAndExit = async () => {
    setPhase("saving");
    const bad = await p.onSave((done, total) => setProgress({ done, total }));
    if (bad.length === 0) {
      settle((x) => x.kind === "unsavedFiles" && x.resolve("save"));
      return;
    }
    setFailed(bad);
    setPhase("failed");
  };

  if (phase === "failed") {
    return (
      <>
        <div className="hd" style={{ color: "hsl(var(--destructive-ink))" }}>
          <Icon name="alertTriangle" size={16} />
          有 {failed.length} 个文件没能保存
        </div>
        <div className="bd one">
          <ul style={{ margin: "0 0 8px", paddingLeft: 18, display: "grid", gap: 6 }}>
            {failed.map((f) => (
              <li key={f.path}>
                <b className="dbx-mono">{f.name}</b>
                <div className="dbx-muted">{f.reason}</div>
              </li>
            ))}
          </ul>
          <p className="dbx-muted">现在退出，这些文件的修改会丢失。建议回编辑器处理后再关窗。</p>
        </div>
        <div className="ft">
          <span className="dbx-sp" />
          <button type="button" className="dbx-btn" onClick={() => settle((x) => x.kind === "unsavedFiles" && x.resolve("cancel"))}>
            返回编辑器处理
          </button>
          <button type="button" className="dbx-btn bad" onClick={() => settle((x) => x.kind === "unsavedFiles" && x.resolve("discard"))}>
            不保存并退出
          </button>
        </div>
      </>
    );
  }

  const busy = phase === "saving";
  return (
    <>
      <div className="hd">
        <Icon name="alertTriangle" size={16} />
        退出前有 {p.files.length} 个文件未保存
      </div>
      <div className="bd one">
        <p style={{ marginBottom: 6 }}>这些文件改过但还没写到磁盘，现在退出改动会丢失。</p>
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4, maxHeight: 168, overflowY: "auto" }}>
          {p.files.map((f) => (
            <li key={f.path} className="dbx-mono" title={f.path}>
              {f.name}
              {f.preview && <span className="dbx-muted">（预览）</span>}
            </li>
          ))}
        </ul>
      </div>
      <div className="ft">
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn" disabled={busy} onClick={() => settle((x) => x.kind === "unsavedFiles" && x.resolve("cancel"))}>
          取消
        </button>
        <button type="button" className="dbx-btn bad" disabled={busy} onClick={() => settle((x) => x.kind === "unsavedFiles" && x.resolve("discard"))}>
          不保存并退出
        </button>
        <button type="button" className="dbx-btn pri" disabled={busy} onClick={() => void saveAndExit()}>
          {busy ? `正在保存 ${progress.done}/${progress.total}` : "保存全部并退出"}
        </button>
      </div>
    </>
  );
}
