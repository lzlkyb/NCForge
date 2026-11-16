import { useState } from "react";
import { invoke, invokeOrToast } from "../../lib/tauri";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { SettingsRow } from "../ui/SettingsRow";
import { Modal } from "../ui/Modal";
import "./settings-maintenance.css";

/**
 * 诊断日志：把前端崩溃现场交给用户/同事，不必依赖「记得点复制错误信息」。
 *
 * 🔴 为什么要有这个入口：错误已经落盘（`frontend_log`），但用户不知道去哪找。
 * 没有入口的日志等于没有日志——排障时还是只能靠口述。
 *
 * 只读不删：日志里可能含路径与 SQL 片段，删除与否交给用户自己在资源管理器里处置，
 * 应用不代删（与 `change_shelf` 坏副本不删同一口径）。
 */
export function DiagnosticsSettings() {
  const [text, setText] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const view = async () => {
    setReading(true);
    try {
      const log = await invoke<string>("frontend_log_read", { maxBytes: 64 * 1024 });
      setText(log && log.trim() ? log : "");
    } catch {
      // 读失败不进弹窗：invokeOrToast 已提示，这里保持面板不打开
      setText(null);
    } finally {
      setReading(false);
    }
  };

  return <Card className="settings-maintenance-section">
    <div className="settings-maintenance-heading">
      <h2>诊断日志</h2>
      <p>界面出错时自动记录到本机，排查问题时可直接查看或发给同事。</p>
    </div>
    <SettingsRow
      id="diagnostics-view"
      label="错误记录"
      keywords={["日志", "崩溃", "报错", "排查", "堆栈", "log", "diagnostics"]}
      sub="只保存在本机，不上传"
      info="记录界面渲染异常与未处理的异步错误，含堆栈与发生时间。单份上限 2 MB，超出后保留一份历史。日志可能包含文件路径，发给他人前请先自行确认。"
      valueText={reading ? "读取中" : "本机日志"}
      control={
        <Button variant="outline" size="sm" isLoading={reading} loadingText="读取中…" disabled={reading} onClick={() => void view()}>
          查看
        </Button>
      }
    />
    <SettingsRow
      id="diagnostics-reveal"
      label="日志文件位置"
      keywords={["目录", "文件夹", "打开", "资源管理器", "log"]}
      sub="在资源管理器中打开"
      last
      control={
        <Button variant="outline" size="sm" onClick={() => void invokeOrToast("frontend_log_reveal", undefined, "打开日志目录失败")}>
          打开目录
        </Button>
      }
    />
    <Modal open={text !== null} onClose={() => setText(null)} ariaLabel="错误记录">
      <h3 className="mb-2 text-sm font-medium text-foreground">错误记录</h3>
      {text
        ? <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs text-muted-foreground">{text}</pre>
        : <p className="text-sm text-muted-foreground">暂无错误记录。</p>}
    </Modal>
  </Card>;
}