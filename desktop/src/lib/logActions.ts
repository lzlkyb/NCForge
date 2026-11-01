import { toast } from "../components/ui/toast";
import { requestOpenFile } from "./openFileRequest";
import { openPalette } from "./paletteStore";
import type { Jump } from "./ncLog";

/**
 * 归因结论里的「跳转」动作。
 *
 * 三个动作都复用已有入口，不新造机制：
 * - **表** → `openTableInDb`（表结构悬停卡片里那个「在数据库中打开」走的就是它）
 * - **upm** → `requestOpenFile`（和搜索页/版本控制页同一条管道）
 * - **类名** → 复制到剪贴板 + 打开「类型搜索」浮层
 *
 * 🔴 数据库那两个模块用**动态 import**。`openTableInDb` 会拉进 `dbStore` / `dbConfirm`，
 * 直接静态引入会让日志页的依赖图多出一大坨，组件测试里也更容易踩到 jsdom 的坑。
 * 点一次跳转多花几毫秒加载 chunk，比整页变慢划算。
 */
export async function runJump(jump: Jump): Promise<void> {
  try {
    switch (jump.kind) {
      case "table": {
        const { openTableInDb } = await import("./openTableFromHover");
        await openTableInDb(jump.table);
        return;
      }
      case "upm": {
        requestOpenFile({ path: jump.path });
        return;
      }
      case "source": {
        // 类名本身没有源码路径，得靠 jdt.ls 的类型搜索去定位。
        // 顺手复制一份：浮层打开后直接 Ctrl+V 就能搜，少一次口述类名的痛苦。
        await copyText(jump.class).catch(() => undefined);
        openPalette("type");
        toast(`已复制类名 ${jump.class}，在类型搜索里粘贴即可定位`, "success");
        return;
      }
    }
  } catch (e) {
    toast(`跳转失败：${String(e)}`, "error");
  }
}

/**
 * 「复制到 SQL 窗口」：把慢 SQL / 报错里那条语句送进数据库页的新控制台。
 *
 * `newConsole` 在 `dbActions.ts` 里，那个文件静态引入 `sqlModels` → `monacoSetup`，
 * 一旦被日志页静态引入，Monaco 就会跟着日志页进 jsdom（组件测试直接挂）。
 * 所以整条路径都走动态 import。
 */
export async function openSqlInDb(sql: string): Promise<void> {
  const text = sql.trim();
  if (!text) {
    toast("这条记录里没有可执行的 SQL", "warning");
    return;
  }
  try {
    // 先切页：控制台可能还要建连接，让人看着进度，别点了像没反应
    window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "db" }));
    const { newConsole } = await import("./dbActions");
    await newConsole(undefined, text);
  } catch (e) {
    toast(`打开 SQL 窗口失败：${String(e)}`, "error");
  }
}

/** 复制文本。`navigator.clipboard` 不是所有环境都有（jsdom / 非安全上下文）。 */
export async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard) throw new Error("当前环境不支持剪贴板");
  await navigator.clipboard.writeText(text);
}

/** 复制并给反馈（列表行上的「复制」按钮用）。 */
export async function copyWithToast(text: string, what: string): Promise<void> {
  try {
    await copyText(text);
    toast(`已复制${what}`, "success");
  } catch {
    toast("复制失败：当前环境不支持剪贴板", "error");
  }
}
