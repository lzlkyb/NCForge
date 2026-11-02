import { useEffect, useState } from "react";
import { Icon } from "../ui/icon";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { linkedProjects, type LinkedGraph } from "../../lib/linkedProjects";
import { toast } from "../ui/toast";

/** 预演结果：成功带图，失败只有一句原因（两者互斥，`graph` 为 null 时必看 `error`）。 */
type Preview = { root: string; graph: LinkedGraph | null; error: string | null };

/**
 * 切换工作区（带预演）。
 *
 * 为什么不能「输入即切换」：切过去 jdt.ls 要重建索引、影子工程重来、打开的标签全关，
 * 是有代价的。所以先给一个**预演**（`linked_projects(root)` 只读解析，不动配置），
 * 看清那个工程的依赖链与目录数，再决定切不切——"切过去再切回来"同样要付一次代价。
 */
export function WorkspaceSwitch({
  current,
  busy,
  unsavedCount,
  onSwitch,
}: {
  current: string;
  busy: boolean;
  unsavedCount: number;
  onSwitch: (path: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState(current);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirm, setConfirm] = useState(false);

  // 切换成功后 current 会变：输入框跟着指向新工作区，否则它会停在一个「已经不是当前」的路径上
  useEffect(() => {
    setValue(current);
  }, [current]);

  const path = value.trim();
  const same = !path || path.toLowerCase() === current.toLowerCase();

  const runPreview = async () => {
    if (!path) return;
    if (same) {
      toast("这就是当前工作区", "info");
      return;
    }
    try {
      const graph = await linkedProjects(path);
      setPreview({ root: path, graph, error: null });
    } catch (e) {
      setPreview({ root: path, graph: null, error: String(e) });
    }
  };

  return (
    <section className="lnk-sec">
      <h3 className="lnk-sec-title">
        工作区
        <span className="lnk-hint">
          {current ? `当前 ${current}` : "还没有选择工作区"}
        </span>
      </h3>

      <div className="lnk-add">
        <input
          className="lnk-inp mono"
          placeholder="工程根目录（含 .classpath 的那一层，例如 C:\work\aier\EyePortal）"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void runPreview();
            }
          }}
        />
        <button type="button" className="lnk-btn" disabled={!path} onClick={() => void runPreview()}>
          <Icon name="eye" size={12} />
          预演
        </button>
        <button
          type="button"
          className="lnk-btn pri"
          disabled={same || busy}
          title={same ? "已经是当前工作区" : "切换后代码智能会重建索引，打开的标签会关闭"}
          onClick={() => setConfirm(true)}
        >
          {busy ? "切换中…" : "切换到此工作区"}
        </button>
      </div>

      {preview && (
        <div className="lnk-preview" data-bad={preview.graph ? undefined : true}>
          {preview.graph ? (
            <>
              <div className="lnk-preview-head">
                预演 <code className="lnk-dir">{preview.root}</code> → 主工程{" "}
                <b>{preview.graph.primary}</b>，{preview.graph.projects.length} 个工程 /{" "}
                {preview.graph.totalDirCount} 个类目录
                <button type="button" className="lnk-ibtn" title="关掉预演" onClick={() => setPreview(null)}>
                  <Icon name="close" size={12} />
                </button>
              </div>
              <ol className="lnk-preview-list">
                {preview.graph.projects.map((p, i) => (
                  <li key={`${p.name}-${i}`}>
                    <span className="lnk-idx">{i + 1}</span>
                    {p.name}
                    <span className="lnk-hint">{p.classDirs.length} 个目录</span>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <span>预演失败：{preview.error}</span>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirm}
        variant="destructive"
        title="切换到另一个工作区？"
        description={
          <>
            将把工作区切到 <code className="lnk-dir">{path}</code>。代码智能会停掉并重建索引
            （大工程要等一会儿），当前打开的文件标签全部关闭。
          </>
        }
        confirmLabel={unsavedCount > 0 ? `保存 ${unsavedCount} 个文件并切换` : "切换"}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          void (async () => {
            if (await onSwitch(path)) {
              setPreview(null);
            }
          })();
        }}
      >
        {unsavedCount > 0 && (
          <p className="lnk-warn">
            有 {unsavedCount} 个文件还没保存：切换前会先逐个保存，
            <b>任何一个保存失败都会中止切换</b>
            （冲突时不替你决定覆盖，去代码页处理完再切）。
          </p>
        )}
      </ConfirmDialog>
    </section>
  );
}
