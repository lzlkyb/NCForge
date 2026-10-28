import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import type { Eol } from "../../lib/workspace";
import type { TabMeta } from "../../lib/workspaceSession";

/**
 * 编辑器上方的提示条。四条互不相干，各自判自己的显隐条件：
 *
 * - 混合换行：保存会改动整个文件的行尾（SVN 里是整文件 diff），默认只读，让人选一种统一。
 * - 无法无损往返：保存会破坏原文件，硬拦成只读，不给「坚持保存」。
 * - 异地修改：可能已被 AI 或 Eclipse 改过，让人决定覆盖还是重新加载。
 * - 大文件：降级提示，可以关掉（关掉只是不提示，降级本身仍然生效）。
 */
export function EditorBanners({
  active,
  activePath,
  conflictPath,
  showLargeHint,
  onUnifyEol,
  onReload,
  onOverwriteSave,
  onDismissLargeHint,
}: {
  active: TabMeta | null;
  activePath: string | null;
  conflictPath: string | null;
  showLargeHint: boolean;
  onUnifyEol: (path: string, eol: Eol) => void;
  onReload: (path: string) => void;
  onOverwriteSave: (path: string) => void;
  onDismissLargeHint: (path: string) => void;
}) {
  return (
    <>
      {active?.readOnlyReason === "mixed" && (
        <div className="wb-banner">
          <Icon name="alertTriangle" size={14} />
          混合换行：保存会改动整个文件的行尾（SVN 里是整文件 diff），默认只读
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
      {conflictPath !== null && conflictPath === activePath && (
        <div className="wb-banner" data-tone="bad">
          <Icon name="alertTriangle" size={14} />
          文件在磁盘上已被其他程序修改（如 AI 或 Eclipse），未保存
          <div className="wb-banner-actions">
            <Button size="sm" variant="outline" onClick={() => onReload(conflictPath)}>
              放弃我的修改并重新加载
            </Button>
            <Button size="sm" variant="destructive" onClick={() => onOverwriteSave(conflictPath)}>
              覆盖保存
            </Button>
          </div>
        </div>
      )}
      {active?.virtual && (
        <div className="wb-banner">
          <Icon name="info" size={14} />
          {active.virtual === "source"
            ? "NC 标准库 jar 里的类，配有源码，只读"
            : "这个类没有配套源码（_src.jar），只显示方法签名，只读"}
        </div>
      )}
      {showLargeHint && active && (
        <div className="wb-banner">
          <Icon name="info" size={14} />
          <span className="wb-banner-text">
            <b>{active.lines}</b> 行的大文件：为保证打字流畅，已关掉括号对着色、代码折叠与小地图；语法高亮、搜索、编译不受影响
          </span>
          <button
            type="button"
            className="wb-banner-x"
            title="关闭提示"
            aria-label="关闭提示"
            onClick={() => onDismissLargeHint(active.path)}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
    </>
  );
}
