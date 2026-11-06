import { Button } from "../ui/button";
import { missingResourceId } from "../../lib/resourceMissing";
import { ResourceDownloadButton } from "../resource/ResourceDownloadButton";
import { Icon } from "../ui/icon";
import { ReadingNotice } from "./ReadingNotice";
import { useOperations } from "../../lib/operations";
import type { Eol } from "../../lib/workspace";
import type { TabMeta } from "../../lib/workspaceSession";

/**
 * 编辑器上方的提示条。每条互不相干，各自判自己的显隐条件：
 *
 * - 混合换行：保存会改动整个文件的行尾（SVN 里是整文件 diff），默认只读，让人选一种统一。
 * - 无法无损往返：保存会破坏原文件，硬拦成只读，不给「坚持保存」。
 * - 编码写不出：GBK 里写进了它表示不了的字符，给「转成 UTF-8 保存」的出口。
 * - 异地修改：可能已被 AI 或 Eclipse 改过，让人决定覆盖还是重新加载。
 * - 大文件：降级提示，可以关掉（关掉只是不提示，降级本身仍然生效）。
 */
export function EditorBanners({
  active,
  activePath,
  conflictPath,
  encodingIssue,
  showLargeHint,
  onUnifyEol,
  onReload,
  onOverwriteSave,
  onSaveUtf8,
  onDismissLargeHint,
}: {
  active: TabMeta | null;
  activePath: string | null;
  conflictPath: string | null;
  encodingIssue: { path: string; message: string } | null;
  showLargeHint: boolean;
  onUnifyEol: (path: string, eol: Eol) => void;
  onReload: (path: string) => void;
  onOverwriteSave: (path: string) => void;
  onSaveUtf8: (path: string) => void;
  onDismissLargeHint: (path: string) => void;
}) {
  const tasks = useOperations();
  const saveBusy=tasks.some(o=>o.key===`file.save:${activePath?.toLowerCase()}` && o.endedAt===undefined);
  const reloadBusy=tasks.some(o=>o.key===`file.reload:${activePath?.toLowerCase()}` && o.endedAt===undefined);
  return (
    <>
      {active?.readOnlyReason === "mixed" && (
        <div className="wb-banner">
          <Icon name="alertTriangle" size={14} />
          混合换行：编辑器里显示的是行尾归一化成 LF 之后的内容（磁盘原文没动），
          保存会把整个文件统一成你选的那种行尾——SVN 里就是整文件 diff
          <div className="wb-banner-actions">
            <Button size="sm" variant="outline" onClick={() => onUnifyEol(active.path, "CRLF")}>
              统一为 CRLF 并编辑
            </Button>
            <Button size="sm" variant="outline" onClick={() => onUnifyEol(active.path, "LF")}>
              统一为 LF 并编辑
            </Button>
          </div>
        </div>
      )}
      {active?.readOnlyReason === "lossy" && (
        <div className="wb-banner" data-tone="bad">
          <Icon name="alertTriangle" size={14} />
          文件含无法无损往返的字节，保存会破坏原文件，已设为只读
        </div>
      )}
      {encodingIssue !== null && encodingIssue.path === activePath && (
        <div className="wb-banner" data-tone="bad">
          <Icon name="alertTriangle" size={14} />
          {encodingIssue.message}
          <div className="wb-banner-actions">
            <Button size="sm" variant="outline" isLoading={saveBusy} loadingText="保存中" disabled={reloadBusy} onClick={() => onSaveUtf8(encodingIssue.path)}>
              转为 UTF-8 保存
            </Button>
          </div>
        </div>
      )}
      {conflictPath !== null && conflictPath === activePath && (
        <div className="wb-banner" data-tone="bad">
          <Icon name="alertTriangle" size={14} />
          文件在磁盘上已被其他程序修改（如 AI 或 Eclipse），未保存
          <div className="wb-banner-actions">
            <Button size="sm" variant="outline" isLoading={reloadBusy} loadingText="重新加载中" disabled={saveBusy} onClick={() => onReload(conflictPath)}>
              放弃我的修改并重新加载
            </Button>
            <Button size="sm" variant="destructive" isLoading={saveBusy} loadingText="保存中" disabled={reloadBusy} onClick={() => onOverwriteSave(conflictPath)}>
              覆盖保存
            </Button>
          </div>
        </div>
      )}
      {active?.virtual && (
        <ReadingNotice summary={active.virtual === "source" ? "依赖库源码 · 只读" : active.virtual === "decompiled" ? "反编译源码 · 只读" : "类方法签名 · 只读"}
          detail={active.virtual === "source" ? "NC 标准库 jar 已附带源码，可阅读和导航。" : active.virtual === "decompiled" ? "这个类没有配套源码（_src.jar），显示 CFR 的近似实现；局部变量名可能丢失，语法糖可能展开，与原始源码不逐字一致。" : "这个类没有配套源码，反编译也未成功；当前仅显示方法签名。"}>
          {active.virtual === "stub" && missingResourceId(active.decompileError) === "cfr" && <div className="wb-banner-actions"><ResourceDownloadButton id="cfr" /><span>下载完成后再次打开这个类即可重试</span></div>}
        </ReadingNotice>
      )}
      {showLargeHint && active && (
        <ReadingNotice summary={`${active.lines} 行大文件 · 阅读优化已启用`}
          detail="已暂停括号对着色、代码折叠和小地图；语法高亮、搜索、编译和补全仍可用。代码智能首次分析可能较慢。" dismiss={() => onDismissLargeHint(active.path)} />
      )}
    </>
  );
}
