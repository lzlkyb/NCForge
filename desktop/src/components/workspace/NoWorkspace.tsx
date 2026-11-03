import { useState } from "react";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/EmptyState";
import { Input } from "../ui/input";
import { baseName } from "../../lib/workspace";

/** 还没选工作区时的引导页：明确说「输一个目录」，不让用户盲猜。 */
export function NoWorkspace({
  value,
  recents,
  onChange,
  onOpen,
}: {
  value: string;
  /** 最近打开过的工作区：新装机器没有，列表为空时不占空间。 */
  recents: string[];
  onChange: (value: string) => void;
  /** 打开失败时返回原因（页面同时也会 toast），成功返回 null。 */
  onOpen: (path: string) => Promise<string | null>;
}) {
  // 失败原因留在输入框下方：只 toast 会随几秒消失，用户回头再看
  // 已经不知道刚才为什么没打开，而输入框里的路径还留着
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = value.trim().length > 0 && !busy;
  const open = async (path: string) => {
    if (!path.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setError(await onOpen(path));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4">
      <EmptyState
        icon="folder"
        description="还没有打开工程目录。输入 NC 二开工程的根目录（如 newar 所在的路径）。"
        className="w-[420px] py-10"
        action={
          <div className="flex w-[360px] flex-col gap-1.5">
            <div className="flex gap-2">
              <Input
                value={value}
                placeholder={"C:\\work\\aier\\newar"}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "wb-root-error" : undefined}
                onChange={(e) => {
                  onChange(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => e.key === "Enter" && ready && void open(value)}
              />
              <Button disabled={!ready} onClick={() => void open(value)}>
                {busy ? "打开中…" : "打开"}
              </Button>
            </div>
            {error && (
              <div id="wb-root-error" role="alert" className="wb-root-error">
                {error}
              </div>
            )}
          </div>
        }
      />
      {recents.length > 0 && (
        <div className="wb-root-recent wb-root-recent-empty">
          <span className="wb-root-recent-label">最近打开</span>
          {recents.map((p) => (
            <button key={p} type="button" className="wb-root-recent-item" title={p}
              disabled={busy} onClick={() => void open(p)}>
              {baseName(p)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
