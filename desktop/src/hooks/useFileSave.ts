import { useEffect, useRef, useState } from "react";
import { getText, markSaved, replaceContent } from "../lib/editorStore";
import {
  cleanError,
  isConflictError,
  isUnencodableError,
  readFile,
  writeFile,
  type TextEncoding,
} from "../lib/workspace";
import { applySaved } from "../lib/tabSession";
import { setSession, type TabMeta, type Updater } from "../lib/workspaceSession";
import { toast } from "../components/ui/toast";

/**
 * 保存与异地冲突：Ctrl+S、「转成 UTF-8 保存」、冲突后「重新加载」。
 *
 * 从 useFileSession 里拆出来：保存只依赖标签数组与激活项，和打开 / 关闭 / 改名跟随无关。
 */
export function useFileSave(tabs: TabMeta[], activePath: string | null) {
  const setTabs = (v: Updater<TabMeta[]>) => setSession({ tabs: v });
  const setConflictPath = (v: Updater<string | null>) => setSession({ conflictPath: v });
  const setEncodingIssue = (v: Updater<{ path: string; message: string } | null>) =>
    setSession({ encodingIssue: v });
  const [saving, setSaving] = useState(false);
  /**
   * 进行态的同步副本。`saving` 是渲染期才更新的，两个 Ctrl+S 落在同一个 tick 时
   * 双方都读到 false，会写两次盘（第二次还会带着第一次的旧 mtime 触发冲突误报）。
   */
  const savingRef = useRef(false);
  /**
   * 保存。`encodingOverride` 用于「转成 UTF-8 保存」——GBK 文件写进了它表示不了的
   * 字符时，后端会拒（`UNENCODABLE`），这条路径把编码换掉再存一次。
   */
  const saveFile = async (path: string, force = false, encodingOverride?: TextEncoding) => {
    const tab = tabs.find((t) => t.path === path);
    if (!tab || tab.readOnly || savingRef.current) return;
    const text = getText(path);
    if (text === undefined) return;
    const encoding = encodingOverride ?? tab.encoding;
    // 转 UTF-8 时不写 BOM：BOM 是「原来是 UTF-8 带 BOM」这个事实的延续，
    // 转换后的文件不该凭空多出三个字节。
    const hasBom = encodingOverride === "UTF-8" ? false : tab.hasBom;
    savingRef.current = true;
    setSaving(true);
    try {
      const mtime = await writeFile({
        path,
        text,
        encoding,
        hasBom,
        eol: tab.eol,
        expectedMtimeMs: force ? null : tab.mtimeMs,
      });
      markSaved(path);
      setTabs((ts) =>
        applySaved(ts, path, { mtimeMs: mtime, encoding, hasBom, converted: !!encodingOverride }),
      );
      setConflictPath(null);
      setEncodingIssue(null);
      toast(encodingOverride ? `已转为 UTF-8 并保存 ${tab.name}` : `已保存 ${tab.name}`, "success");
    } catch (e) {
      if (isConflictError(e)) setConflictPath(path);
      else if (isUnencodableError(e)) setEncodingIssue({ path, message: cleanError(e) });
      else toast(`保存失败：${cleanError(e)}`, "error");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  /** 「转成 UTF-8 保存」按钮。 */
  const saveAsUtf8 = async (path: string) => {
    setEncodingIssue(null);
    await saveFile(path, false, "UTF-8");
  };

  // Editor remains mounted behind tools; only save when its surface owns the shortcut.
  const saveRef = useRef(saveFile);
  saveRef.current = saveFile;
  const activeRef = useRef(activePath);
  activeRef.current = activePath;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('[role="dialog"][aria-modal="true"]:not([data-exiting])')) return;
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

  /** 异地修改后选「重新加载」：丢弃编辑器里的修改，采用磁盘版本。 */
  const reloadFile = async (path: string) => {
    try {
      const c = await readFile(path);
      replaceContent(path, c);
      setTabs((ts) =>
        ts.map((t) =>
          t.path === path
            ? { ...t, encoding: c.encoding, hasBom: c.hasBom, eol: c.eol, mtimeMs: c.mtimeMs, dirty: false, eolChanged: false }
            : t,
        ),
      );
      setConflictPath(null);
    } catch (e) {
      toast(`重新加载失败：${e}`, "error");
    }
  };

  return { saving, saveFile, saveAsUtf8, reloadFile };
}
