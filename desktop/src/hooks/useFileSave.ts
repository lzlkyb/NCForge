import { useEffect, useRef, useState } from "react";
import { queueAutoCompile } from "../lib/autoCompileQueue";
import { isJavaFile } from "../lib/autoCompile";
import { autoCompileCached } from "../lib/appConfig";
import { getModel, replaceContent } from "../lib/editorStore";
import { operationActive, trackOperation } from "../lib/operations";
import { saveOne } from "../lib/fileSave";
import { workspaceEpoch } from "../lib/workspaceEpoch";
import { markLocalSave } from "../lib/localSaves";
import {
  cleanError,
  isConflictError,
  isUnencodableError,
  readFile,
  type TextEncoding,
} from "../lib/workspace";
import { applySaved, tabMetaFromDisk } from "../lib/tabSession";
import { getSession, setSession, type TabMeta, type Updater } from "../lib/workspaceSession";
import { toast } from "../components/ui/toast";

/**
 * 保存与异地冲突：Ctrl+S、「转成 UTF-8 保存」、冲突后「重新加载」。
 *
 * 从 useFileSession 里拆出来：保存只依赖标签数组与激活项，和打开 / 关闭 / 改名跟随无关。
 */
export function useFileSave(activePath: string | null) {
  const setTabs = (v: Updater<TabMeta[]>) => setSession({ tabs: v });
  const setConflictPath = (v: Updater<string | null>) => setSession({ conflictPath: v });
  const setEncodingIssue = (v: Updater<{ path: string; message: string } | null>) =>
    setSession({ encodingIssue: v });
  const [saving, setSaving] = useState(false);
  /**
   * 进行态的同步副本。`saving` 是渲染期才更新的，两个 Ctrl+S 落在同一个 tick 时
   * 双方都读到 false，会写两次盘（第二次还会带着第一次的旧 mtime 触发冲突误报）。
   *
   * 按**文件**记而不是全局一个布尔：A 在写盘时用户切到 B 按 Ctrl+S，全局单飞会把
   * B 的保存静默丢掉（`return` 得无声无息），看起来就是「Ctrl+S 没反应」。
   */
  const savingRef = useRef(new Set<string>());
  /**
   * 保存。`encodingOverride` 用于「转成 UTF-8 保存」——GBK 文件写进了它表示不了的
   * 字符时，后端会拒（`UNENCODABLE`），这条路径把编码换掉再存一次。
   *
   * 写盘本身在 `lib/fileSave.ts`（模块级），退出流程复用同一份；这里只负责
   * 并发保护、标签回写与错误分类。
   */
  const saveFile = async (path: string, force = false, encodingOverride?: TextEncoding, prepare?: () => Promise<void | "failed">) => {
    const tab = getSession().tabs.find((t) => t.path === path);
    const root = getSession().root,epoch=workspaceEpoch();
    const savingKey = path.toLowerCase();
    if (!tab || tab.readOnly || savingRef.current.has(savingKey) || operationActive(`file.reload:${savingKey}`)) return;
    savingRef.current.add(savingKey);
    setSaving(true);
    try {
      await trackOperation({ key:`file.save:${path.toLowerCase()}`,label:`保存 ${tab.name}`,scope:path,page:"files",path,phase:prepare?"保存前格式化":"正在写入文件" }, async task => {
        const formatResult = await prepare?.();
        const latest = getSession().tabs.find(t => t.path === path);
        if (epoch !== workspaceEpoch() || root !== getSession().root || !latest) { task.finish("cancelled", "文件已关闭或工程已切换，未写入"); return; }
        task.update({phase:"归档旧版本并写入文件"});
        // 先记下「这是我们写的」再落盘：监听事件可能比 saveOne 的返回先到
        markLocalSave(path);
        const r = await saveOne(latest, { force, encodingOverride });
        if (epoch !== workspaceEpoch() || root !== getSession().root) { task.finish("success", "已写入原工程文件"); return; }
        setTabs((ts) => applySaved(ts, path, r));
        // 只清这个文件自己的提示：A 存成功不该把 B 的「异地修改」对话抹掉，
        // 那条提示是 B 的未决决策，抹掉后用户会以为冲突已经处理完了。
        setConflictPath((v) => (v === path ? null : v));
        setEncodingIssue((v) => (v?.path === path ? null : v));
        // 保存后自动编译（防抖 700 ms，由 useModuleCompile 消费）。放在这里而不是
        // `saveOne` 里：退出流程的「保存全部」也走 saveOne，那时候不该起 JVM。
        //
        // 入队成功时**不弹「已保存」**：700 ms 后就会有编译结果回来（或一条跳过提示），
        // 紧接着再弹一条绿色 toast 只会把真正要看的那条顶掉。没入队（自动编译关掉 /
        // 不在文件页 / 不是 .java / 没有工作区）时才提示，那种情况下用户没有别的反馈。
        const willCompile =
          isJavaFile(path) &&
          autoCompileCached() &&
          !!getSession().root &&
          queueAutoCompile(path);
        if (!willCompile) {
          toast(`${encodingOverride ? "已转为 UTF-8 并保存" : "已保存"} ${tab.name}${formatResult === "failed" ? "（格式化未完成）" : ""}`, "success");
        }
        task.finish("success", `文件已保存${formatResult === "failed" ? "；格式化未完成" : ""}${willCompile ? "；自动编译已排队" : ""}${getSession().tabs.find(t=>t.path===path)?.dirty ? "；后续编辑仍未保存" : ""}`);
      });
    } catch (e) {
      if (isConflictError(e)) setConflictPath(path);
      else if (isUnencodableError(e)) setEncodingIssue({ path, message: cleanError(e) });
      else toast(`保存失败：${cleanError(e)}`, "error");
    } finally {
      savingRef.current.delete(savingKey);
      setSaving(savingRef.current.size > 0);
    }
  };

  /** 「转成 UTF-8 保存」按钮。提示条由 saveFile 成功后按路径清掉——这里先清的话，
   *  保存失败（还是编不了）时用户就看不到原因了，输入框下方的错误也一起消失。 */
  const saveAsUtf8 = async (path: string) => {
    await saveFile(path, false, "UTF-8");
  };

  // Editor remains mounted behind tools; only save when its surface owns the shortcut.
  const saveRef = useRef(saveFile);
  saveRef.current = saveFile;
  const activeRef = useRef(activePath);
  activeRef.current = activePath;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || document.querySelector('[role="dialog"][aria-modal="true"]:not([data-exiting])')) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (document.querySelector('.wb-code-surface[hidden]') || target && !target.closest('.monaco-editor') && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (!e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== "s") return;
      const path = activeRef.current;
      if (!path) return;
      e.preventDefault();
      void saveRef.current(path);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * 异地修改后选「重新加载」：丢弃编辑器里的修改，采用磁盘版本。
   *
   * 元数据整份按「像刚打开那样」重建（`tabMetaFromDisk`）：只改编码/换行/mtime 会漏掉
   * 行数、只读状态。磁盘上的新版本可能变成混合换行或编码有损，而旧标签仍是可写状态，
   * 下一次 Ctrl+S 就会把文件写坏。
   */
  const reloadFile = async (path: string) => {
    if (savingRef.current.has(path.toLowerCase()) || operationActive(`file.reload:${path.toLowerCase()}`)) return;
    const root = getSession().root,epoch=workspaceEpoch();
    const model = getModel(path);
    const version = model?.getAlternativeVersionId();
    try {
      await trackOperation({key:`file.reload:${path.toLowerCase()}`,label:"重新加载文件",scope:path,page:"files",path,phase:"读取磁盘上的版本"},async task=>{
        const c = await readFile(path);
        if (epoch !== workspaceEpoch() || root !== getSession().root || !getSession().tabs.some(t=>t.path===path)) {task.finish("cancelled","工程已切换或文件已关闭，未覆盖编辑器");return;}
        if (getModel(path) !== model || model?.getAlternativeVersionId() !== version) throw new Error("读取期间文件有新编辑，已保留修改；请再次确认后重新加载");
        const meta = tabMetaFromDisk(path, c);
        replaceContent(path, c);
        setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, ...meta, preview: t.preview } : t)));
        setConflictPath((v) => (v === path ? null : v));
      });
    } catch (e) {
      toast(`重新加载失败：${e}`, "error");
    }
  };

  return { saving, saveFile, saveAsUtf8, reloadFile };
}
