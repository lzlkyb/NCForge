import { loadJdtSource } from "../lib/lang";
import { tabMetaFromJdt } from "../lib/tabSession";
import { friendlyError } from "../lib/friendlyError";
import type { TabMeta, Updater } from "../lib/workspaceSession";
import { trackOperation } from "../lib/operations";
import { getSession } from "../lib/workspaceSession";
import { workspaceEpoch } from "../lib/workspaceEpoch";
import { toast } from "../components/ui/toast";

/**
 * 「把 jar 内的类打开成只读标签」这一个动作：读源码（没有源码就反编译）、建标签、失败提示。
 *
 * 为什么单独成 hook 而不是留在 `useFileSession`：那边已经顶到 300 行的体量上限，
 * 而这块逻辑自成一体（只依赖 tabs 与 setTabs）。「反编译失败只提示一次」的记录也放这儿——
 * 它天然属于这个动作，同一个类来回跳不该反复弹同一条错误。
 *
 * 返回 `false` = 读不到源码（已经提示过），调用方不要再激活标签。
 */

/**
 * 已提示过的错误。
 *
 * 模块级而不是 `useRef`：文件页切走会卸载，ref 跟着没了，回来再点同一个类又会弹一次。
 * 而「CFR 组件没下载」根本不是某个类的问题——是全局状态，只该说一遍。
 */
const warned = new Set<string>();

/** 一个错误只提示一次的身份：组件缺失归成一条，其余按类算。 */
const warnKey = (uri: string, message: string) =>
  message.includes("找不到反编译组件") ? "component-missing" : uri;

/**
 * 桩 → 完整实现的后台重试。
 *
 * 用户装好 CFR 组件后，同一个类的标签已经是 stub 了；如果「点第二次」什么都不做，
 * 唯一出路是关掉标签再打开（多数人只会以为功能坏了）。
 */
async function refreshStub(uri: string, setTabs: (v: Updater<TabMeta[]>) => void) {
  try {
    const root=getSession().root,epoch=workspaceEpoch();
    const src = await trackOperation({key:`class:${epoch}:${uri}`,root,label:"重新读取类实现",scope:uri,page:"files",phase:"正在重试源码读取 / 反编译"},()=>loadJdtSource(uri, false, true));
    if(epoch!==workspaceEpoch() || root!==getSession().root) return;
    if (!src.decompiled) return;
    setTabs((ts) =>
      ts.map((t) =>
        t.path === uri && t.virtual === "stub"
          ? { ...tabMetaFromJdt(uri, src.text, true), preview: t.preview }
          : t,
      ),
    );
  } catch {
    // 还是失败：保持桩。原因早就提示过了，重复弹只是噪音
  }
}

export function useJdtOpen(setTabs: (v: Updater<TabMeta[]>) => void) {
  return async (uri: string): Promise<boolean> => {
    // 已有标签：直接转正激活。但如果它还是签名桩，后台试一次反编译——
    // 用户可能刚在设置里装好了组件。
    if (getSession().tabs.some((t) => t.path === uri)) {
      if (getSession().tabs.find((t) => t.path === uri)?.virtual === "stub") {
        void refreshStub(uri, setTabs);
      }
      return true;
    }
    try {
      const root=getSession().root,epoch=workspaceEpoch();
      const src = await trackOperation({key:`class:${epoch}:${uri}`,root,label:"读取库中的类",scope:uri,page:"files",phase:"读取源码，缺少源码时尝试反编译"},()=>loadJdtSource(uri));
      if(epoch!==workspaceEpoch() || root!==getSession().root) return false;
      const meta = { ...tabMetaFromJdt(uri, src.text, src.decompiled), decompileError: src.decompileError ?? undefined };
      setTabs((ts) => (ts.some((t) => t.path === uri) ? ts : [...ts, meta]));
      // 反编译失败退回签名桩：桩没有实现，不说明原因用户只会以为「这个类就长这样」
      if (src.decompileError) {
        const k = warnKey(uri, src.decompileError);
        if (!warned.has(k)) {
          warned.add(k);
          toast(`这个类没有源码，反编译也没成功：${src.decompileError}`, "error");
        }
      }
      return true;
    } catch (e) {
      toast(`无法读取类源码：${friendlyError(e)}`, "error");
      return false;
    }
  };
}
