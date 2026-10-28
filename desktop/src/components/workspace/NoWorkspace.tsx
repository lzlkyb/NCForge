import { Button } from "../ui/button";
import { EmptyState } from "../ui/EmptyState";
import { Input } from "../ui/input";

/** 还没选工作区时的引导页：明确说「输一个目录」，不让用户盲猜。 */
export function NoWorkspace({
  value,
  onChange,
  onOpen,
}: {
  value: string;
  onChange: (value: string) => void;
  onOpen: () => void;
}) {
  const ready = value.trim().length > 0;
  return (
    <div className="flex flex-1 items-center justify-center">
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
    </div>
  );
}
