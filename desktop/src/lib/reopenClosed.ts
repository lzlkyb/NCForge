import { toast } from "../components/ui/toast";
import { popClosed } from "./closedTabs";

/**
 * 重开最近关闭的标签（Ctrl+Shift+T）。
 *
 * 关闭栈里可能残留已被删除 / 改名的路径：逐个往下试，最多 10 次，
 * 不让一个坏路径把整次重开卡死。打开函数由调用方注入（文件页持有 model / 标签的编排）。
 */
export async function reopenClosed(openFile: (path: string) => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    const path = popClosed();
    if (!path) {
      if (i === 0) toast("没有可重新打开的标签", "info");
      return false;
    }
    if (await openFile(path)) return true;
  }
  return false;
}
