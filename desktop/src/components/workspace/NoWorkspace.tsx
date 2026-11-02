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
  onOpenRecent,
}: {
  value: string;
  /** 最近打开过的工作区：新装机器没有，列表为空时不占空间。 */
  recents: string[];
  onChange: (value: string) => void;
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
}) {
  const ready = value.trim().length > 0;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4">
      <EmptyState
        icon="folder"
        description="还没有打开工程目录。输入 NC 二开工程的根目录（如 newar 所在的路径）。"
        className="w-[420px] py-10"
        action={
          <div className="flex w-[360px] gap-2">
            <Input
              value={value}
              placeholder={"C:\\work\\aier\\newar"}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && ready && onOpen()}
            />
            <Button disabled={!ready} onClick={onOpen}>
              打开
            </Button>
          </div>
        }
      />
      {recents.length > 0 && (
        <div className="wb-root-recent wb-root-recent-empty">
          <span className="wb-root-recent-label">最近打开</span>
          {recents.map((p) => (
            <button key={p} type="button" className="wb-root-recent-item" title={p}
              onClick={() => onOpenRecent(p)}>
              {baseName(p)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
