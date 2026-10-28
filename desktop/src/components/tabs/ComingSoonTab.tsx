import { EmptyState } from "../ui/EmptyState";
import type { IconName } from "../ui/icon";

/** 尚未实现的功能入口的占位页：说清楚它会在哪个里程碑开放，不让用户点进去一片空白。 */
export function ComingSoonTab({
  icon,
  title,
  milestone,
}: {
  icon: IconName;
  title: string;
  milestone: string;
}) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <EmptyState icon={icon} description={`${title}还在开发中，预计在 ${milestone} 开放。`} />
    </div>
  );
}
