/**
 * 多个组件共用的纯函数集中于此（规则 11）。
 */

/** H6 修复：统一剪贴板复制入口。navigator.clipboard.writeText 未 await/catch 时，权限被拒绝会出现
 * "显示已复制但其实没复制"的假阳性反馈（ConnectTab/TokenManager/onboarding 多处同款问题）。
 * 调用方传 onSuccess/onError 回调，不内置 toast 依赖（不同调用点的成功/失败文案不一致）。 */
export async function copyText(
  text: string,
  onSuccess: () => void,
  onError?: (e: unknown) => void,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    onSuccess();
  } catch (e) {
    onError?.(e);
  }
}

/* ─── Token 用量展示（纯函数，共用，规则 11）─── */

/* ─── 更新历史「已读」状态（localStorage，纯函数，规则 11）─── */

const CHANGELOG_LAST_SEEN_KEY = "shell_changelog_last_seen";

/** 读取用户上次看到的版本（未看过返回 null）。 */
export function getLastSeenVersion(): string | null {
  try {
    return localStorage.getItem(CHANGELOG_LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

/** 记录用户已看到某版本（通常是当前最新版）。 */
export function setLastSeenVersion(version: string): void {
  try {
    localStorage.setItem(CHANGELOG_LAST_SEEN_KEY, version);
  } catch {
    /* localStorage 不可用时静默忽略，仅影响红点提示 */
  }
}

/** 本版内容实际展示后广播，侧栏据此同步消除提示。 */
export const CHANGELOG_SEEN_EVENT = "ncforge:changelog-seen";

/** 本版亮点可见或版本历史打开后调用，不在启动和隐藏页面挂载时标记。 */
export function markChangelogSeen(latest: string | null): void {
  if (!latest) return;
  const seen = getLastSeenVersion();
  // 浏览较旧的历史不能把阅读进度倒退，导致下次启动再次提醒。
  if (seen && compareVersion(seen, latest) >= 0) return;
  setLastSeenVersion(latest);
  window.dispatchEvent(new Event(CHANGELOG_SEEN_EVENT));
}

/** 语义版本比较：a>b 返回正数，a<b 返回负数，相等 0。 */
export function compareVersion(a: string, b: string): number {
  // 按段取前导整数（parseInt 容忍 "1-rc1" 之类后缀，取到 1）；真正非数字段安全退化为 0。
  // 旧实现用 Number("1-rc1") 得 NaN、再被 || 0 吞成 0，会静默丢掉该段的真实数字。
  const seg = (s: string) => {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? 0 : n;
  };
  const pa = a.split(".").map(seg);
  const pb = b.split(".").map(seg);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

/** 统计比 lastSeen 更新的版本数量（用于「更新」Tab 未读红点）。 */
export function countUnreadVersions(versions: string[], lastSeen: string | null, currentVersion?: string): number {
  if (currentVersion !== undefined) {
    const current = currentVersion.replace(/^v/, "");
    // 提醒只对应实际运行的本版内容；不把随包的未来记录或历代版本累加给用户。
    return versions.includes(current) && (!lastSeen || compareVersion(current, lastSeen) > 0) ? 1 : 0;
  }
  if (!lastSeen) return versions.length; // 从未看过 → 全部未读
  return versions.filter((v) => compareVersion(v, lastSeen) > 0).length;
}

/**
 * 绝对时间（备份 createdAt 形如 "YYYY-MM-DD HH:MM:SS"）转中文相对时间：
 * 刚刚 / X 分钟前 / X 小时前 / X 天前 / X 个月前 / X 年前。
 * 解析失败（如"未知时间"）原样返回，避免崩溃。
 *
 * `nowMs`：相对「哪个时刻」算（Unix ms），测试注入用；不传取当前时间。
 */
export function formatRelativeTime(dateStr: string, nowMs?: number): string {
  if (!dateStr) return "";
  const s = dateStr.includes("T") ? dateStr : dateStr.replace(" ", "T");
  const d = new Date(s);
  if (isNaN(d.getTime())) return dateStr;
  const diffSec = Math.floor(((nowMs ?? Date.now()) - d.getTime()) / 1000);
  if (diffSec < 0) return dateStr; // 未来时间（时钟异常）回退原值
  if (diffSec < 60) return "刚刚";
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon} 个月前`;
  return `${Math.floor(mon / 12)} 年前`;
}

/** 字节数格式化为带单位的人类可读文本（B/KB/MB/GB），SecurityTab 与版本历史弹框共用（规则 11）。 */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val >= 10 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
}

/** 下载速率格式化（复用 formatBytes 加 "/s" 后缀），UpdateBadge/AboutGroup 的更新进度展示共用。 */
export function formatBytesPerSec(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/**
 * 判断键盘事件目标是否是「可编辑元素」（输入框 / 多行文本 / 下拉框 / contentEditable）。
 *
 * 全局快捷键（Ctrl+K 命令面板、Ctrl+1~N 切页、Ctrl+, 开设置、CC 页 Ctrl+N 新对话）在焦点
 * 落在输入区时必须让路，否则用户输密码、敲命令参数会被快捷键劫持。原先 App.tsx 的键盘监听
 * 里写了一份内联闭包，CC 页快捷键同样需要 ⇒ 按规则 11 抽成公共纯函数。
 *
 * 用「鸭子类型」判据而非 `instanceof HTMLElement`：真实 KeyboardEvent.target 一定是真实
 * Node，两者判据等价（document/window 无 tagName、SVG 的 tagName 小写且无 isContentEditable），
 * 但本函数因此可在 node 环境的单元测试里直接用普通对象验证，不必为一个小函数起 jsdom 用例文件。
 */
export function isEditableTarget(el: EventTarget | null): boolean {
  if (!el || typeof el !== "object") return false;
  const node = el as { tagName?: unknown; isContentEditable?: unknown };
  if (typeof node.tagName !== "string") return false;
  return (
    node.tagName === "INPUT" ||
    node.tagName === "TEXTAREA" ||
    node.tagName === "SELECT" ||
    node.isContentEditable === true
  );
}

/**
 * 键盘事件是否发生在输入法组词（IME composition）过程中。
 *
 * 组词期间的 Enter 是「上屏候选词」、Esc 是「收起候选窗」、逗号是普通标点——
 * 都不是对当前 UI 的操作。所有 Enter/Esc/逗号 类提交处理的入口都应先用它放行，
 * 否则中文输入法会被快捷键劫持（候选词还没选，命令就执行了）。
 *
 * 两种判据并用的原因：Safari 的 keydown 在组词中 `isComposing` 恒为 false 但
 * keyCode 会变成 229；反之旧内核只置 `isComposing`。取并集最稳。
 * 鸭子类型（同 isEditableTarget）：React 合成事件传 `e.nativeEvent`，
 * 原生事件直接传 `e`，两者都具备这两个属性，也因此可在 node 单测里直接验证。
 */
export function isImeComposing(e: { isComposing?: unknown; keyCode?: unknown }): boolean {
  return e.isComposing === true || e.keyCode === 229;
}
