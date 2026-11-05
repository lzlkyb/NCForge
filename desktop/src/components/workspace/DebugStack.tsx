// 调试面板左栏：线程列表 + 调用栈。
//
// 线程列表与栈分开看：JVM 里几十个线程是常态，面板一次只显示「当前这一条」的栈，
// 点另一条线程就重新取栈。复制按钮给出 `方法 (文件:行)`，贴进缺陷单能直接定位。
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { baseName } from "../../lib/workspace";
import { copyText } from "../../lib/utils";
import {
  refreshThreadsNow,
  selectFrame,
  selectThread,
  type DebugSnapshot,
} from "../../lib/debugSession";

type Snap = Pick<
  DebugSnapshot,
  "paused" | "threadId" | "threads" | "frames" | "frameId"
>;

export function DebugStack({
  snap,
  onOpenAt,
}: {
  snap: Snap;
  onOpenAt: (path: string, line: number) => void;
}) {
  const location = (name: string, path: string | undefined, line: number) =>
    path ? `${name} (${path}:${line})` : name;

  const jump = (path: string | undefined, line: number) => {
    if (path) onOpenAt(path, line);
  };

  return (
    <>
      <div className="dbg-col-h">
        线程
        {snap.threads.length > 0 && <span>· {snap.threads.length}</span>}
        <button
          type="button"
          className="dbg-icon-btn dbg-hd-btn"
          title="刷新线程列表"
          onClick={() => void refreshThreadsNow()}
        >
          <Icon name="refresh" size={12} />
        </button>
      </div>
      <div className="dbg-thread-list">
        {!snap.paused && <div className="dbg-empty">暂停后显示线程。</div>}
        {snap.paused && snap.threads.length === 0 && <div className="dbg-empty">读取线程…</div>}
        {snap.paused &&
          snap.threads.map((t) => (
            <button
              type="button"
              key={t.id}
              className="dbg-thread"
              data-active={t.id === snap.threadId || undefined}
              title={`查看线程「${t.name}」的调用栈`}
              onClick={() => void selectThread(t.id)}
            >
              <span className="dbg-thread-name">{t.name}</span>
              <span className="dbg-thread-id">#{t.id}</span>
            </button>
          ))}
      </div>

      <div className="dbg-col-h">
        调用栈
        {snap.frames.length > 0 && <span>· {snap.frames.length} 帧</span>}
      </div>
      <div className="dbg-list">
        {!snap.paused && <div className="dbg-empty">运行中：命中断点或按「暂停」后显示调用栈。</div>}
        {snap.paused && snap.frames.length === 0 && <div className="dbg-empty">读取调用栈…</div>}
        {snap.frames.map((f) => (
          <div key={f.id} className="dbg-frame-row" data-active={f.id === snap.frameId || undefined}>
            <button
              type="button"
              className="dbg-frame"
              title={f.source?.path ? `${f.source.path}:${f.line}` : f.name}
              onClick={() => {
                void selectFrame(f.id);
                jump(f.source?.path, f.line);
              }}
            >
              <span className="dbg-frame-name">{f.name}</span>
              <span className="dbg-frame-loc">
                {f.source?.path ? `${baseName(f.source.path)}:${f.line}` : "—"}
              </span>
            </button>
            <button
              type="button"
              className="dbg-icon-btn dbg-frame-copy"
              title="复制位置"
              onClick={(e) => {
                e.stopPropagation();
                void copyText(location(f.name, f.source?.path, f.line), () =>
                  toast("已复制栈帧位置", "success"),
                );
              }}
            >
              <Icon name="copy" size={11} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
