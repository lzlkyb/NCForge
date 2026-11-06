import { ConfirmDialog } from "../ui/ConfirmDialog";
import { GenerateDialog } from "../workspace/GenerateDialog";
import { RenameDialog } from "../workspace/RenameDialog";
import { SwitchProjectDialog } from "../workspace/SwitchProjectDialog";
import { BuildConfirm } from "../workspace/BuildConfirm";
import { baseName } from "../../lib/workspace";
import { isUnsaved } from "../../lib/tabDirty";
import type { TabMeta } from "../../lib/workspaceSession";
import type { SwitchTarget } from "../../hooks/useProjectSwitch";
import type { BuildMaintenance } from "../../hooks/useBuildMaintenance";

/**
 * 文件页的五个弹层：改名、生成代码、构建确认、关标签确认、跨工程切换确认。
 *
 * 从 `FilesTab` 抽出来：页面接线已经贴着组件体量门禁，而弹层只是「把状态交给
 * 对话框组件」，和文件树 / 标签 / 编辑器的编排没有关系。
 */
export function FilesTabDialogs({
  root,
  activePath,
  tabs,
  switchTarget,
  closingPath,
  renameOpen,
  generateOpen,
  build,
  onCloseRename,
  onCloseGenerate,
  onCancelClose,
  onCloseTab,
  onCancelSwitch,
  onConfirmSwitch,
}: {
  root: string;
  activePath: string | null;
  tabs: TabMeta[];
  switchTarget: SwitchTarget | null;
  closingPath: string | null;
  renameOpen: boolean;
  generateOpen: boolean;
  build: BuildMaintenance;
  onCloseRename: () => void;
  onCloseGenerate: () => void;
  onCancelClose: () => void;
  onCloseTab: (path: string, force?: boolean) => void;
  onCancelSwitch: () => void;
  onConfirmSwitch: () => void;
}) {
  return (
    <>
      <RenameDialog open={renameOpen} path={activePath} onClose={onCloseRename} />
      <GenerateDialog open={generateOpen} onClose={onCloseGenerate} />
      <BuildConfirm pending={build.pending} onCancel={build.cancel} onConfirm={build.confirm} />

      <ConfirmDialog
        open={closingPath !== null}
        title="放弃未保存的修改？"
        description={`${baseName(closingPath ?? "")} 有未保存的修改，关闭后将丢失。`}
        variant="destructive"
        confirmLabel="放弃并关闭"
        onCancel={onCancelClose}
        onConfirm={() => {
          if (closingPath) onCloseTab(closingPath, true);
          onCancelClose();
        }}
      />

      <SwitchProjectDialog
        open={switchTarget !== null}
        from={root}
        to={switchTarget?.project ?? null}
        unsavedCount={tabs.filter(isUnsaved).length}
        onCancel={onCancelSwitch}
        onConfirm={onConfirmSwitch}
      />
    </>
  );
}
