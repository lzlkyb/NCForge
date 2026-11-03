import { lazy, Suspense, useEffect, useState } from "react";
import { useLinkedDialog } from "../../lib/linkedDialog";

const LinkedProjectsDialog = lazy(() =>
  import("./LinkedProjectsDialog").then((m) => ({ default: m.LinkedProjectsDialog })),
);

/**
 * 弹框宿主：首次打开才加载弹框代码（它还带着 linked.css 与依赖链相关的件），
 * 之后保持挂载——关掉时 Modal 要播退场动画，立刻卸载会「啪」地消失。
 */
export function LinkedDialogHost() {
  const { open } = useLinkedDialog();
  const [everOpened, setEverOpened] = useState(false);

  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);

  if (!everOpened) return null;
  return (
    <Suspense fallback={null}>
      <LinkedProjectsDialog />
    </Suspense>
  );
}
