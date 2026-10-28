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

/**
 * 秒数格式化为中文时长（精确到秒），用于运行时长 / 已运行列展示。
 *
 * 超过一天后进一位到“天”：服务跑上几天是常态，“86小时40分12秒”读起来很费劲。
 * 只给最大两级单位（如“3天14小时”而不是“3天14小时22分13秒”）：精度再高对“跑了多久”
 * 这个问题没有意义，而卡片右上角宽度有限。不足一分钟时仍给到秒，刚启动时能看到跳。
 */
export function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

/** 版本号统一格式化为 "vX.Y.Z"（已带 v 则不重复加）。各处版本展示共用，避免前缀漂移。 */
export function formatVersion(v?: string): string {
  if (!v) return "?";
  return v.startsWith("v") ? v : `v${v}`;
}

/**
 * 毫秒耗时格式化为一眼可读的中文文本，自动换算单位（微秒/毫秒/秒/分），避免用户看到
 * 大数字（如 10000ms）还要心算，也不用英文缩写（ms/s）而用中文单位。
 * - <1ms：换算成微秒（审计写盘等微秒级耗时仍能看清，不四舍五入成 0）。
 * - <10ms：毫秒保留 1 位小数（区分 1.2毫秒与 8.7毫秒）。
 * - <1000ms：毫秒取整。
 * - <60s：换算成秒（保留 1 位小数，如 10000ms → "10.0秒"）。
 * - ≥60s：换算成 "X分Y秒"。
 */
export function formatDurationMs(ms: number): string {
  if (ms <= 0) return "0毫秒";
  if (ms < 1) return `${Math.round(ms * 1000)}微秒`;
  if (ms < 10) return `${ms.toFixed(1)}毫秒`;
  if (ms < 1000) return `${Math.round(ms)}毫秒`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}秒`;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return `${m}分${s}秒`;
}

/* ─── Token 用量展示（纯函数，共用，规则 11）─── */

/**
 * token 数格式化：≥1 万显示「x.x万」（保留 1 位小数，去尾随 .0），否则千分位原值。
 * 口径是估算值（见后端 audit.rs），展示层不做任何「账单」暗示。
 */
export function fmtTokens(n: number): string {
  if (n < 10000) return n.toLocaleString("en-US");
  const w = n / 10000;
  return `${w >= 100 ? Math.round(w) : Math.round(w * 10) / 10}万`;
}

/** 日期键 "2026-09-27" → 短标签 "9/27"。非法输入原样返回。 */
export function shortDateKey(date: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return `${Number(m[1])}/${Number(m[2])}`;
}

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
export function countUnreadVersions(versions: string[], lastSeen: string | null): number {
  if (!lastSeen) return versions.length; // 从未看过 → 全部未读
  return versions.filter((v) => compareVersion(v, lastSeen) > 0).length;
}

/**
 * 绝对时间（备份 createdAt 形如 "YYYY-MM-DD HH:MM:SS"）转中文相对时间：
 * 刚刚 / X 分钟前 / X 小时前 / X 天前 / X 个月前 / X 年前。
 * 解析失败（如"未知时间"）原样返回，避免崩溃。
 */
export function formatRelativeTime(dateStr: string): string {
  if (!dateStr) return "";
  const s = dateStr.includes("T") ? dateStr : dateStr.replace(" ", "T");
  const d = new Date(s);
  if (isNaN(d.getTime())) return dateStr;
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
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

/**
 * 相对时间，但入参是 **unix 秒**。
 *
 * 历史会话表里存的是秒（`file_mtime / 1000`），转成 ISO 字符串再交给
 * `formatRelativeTime` 去解析纯属绕路 —— 但比在库里存一份字符串好：
 * 时间戳能被排序、能被比较，字符串不能。
 */
export function formatRelativeSecs(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  return formatRelativeTime(new Date(sec * 1000).toISOString());
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
 * 清理 SFTP 报错里的 PTY 噪声：scp/ssh 在 PTY 下会输出 `\r` 进度条、ANSI 转义、
 * 多余空行。剥掉后只留人类可读的错误（权限拒绝 / 路径不存在 / 连接失败等）。
 */
export function cleanErr(raw: unknown): string {
  const s = String(raw ?? "");
  return s
    // eslint-disable-next-line no-control-regex -- 本函数的职责就是剥掉 PTY 的控制字符
    .replace(/\[[0-9;]*m/g, "") // ANSI 颜色
    // eslint-disable-next-line no-control-regex -- 同上：退格是 scp 进度条的刷新方式
    .replace(/[\r]/g, "") // 回车 / 退格（进度条覆盖）
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(-6) // 只取末尾关键几行
    .join("\n")
    .trim();
}

/* ─── 白名单排除规则 glob（与 Rust 侧 security/path.rs 同语义，编辑器实时预览用）─── */

/**
 * fnmatch 式 glob：`**` 跨层（零或多段）、`*` 单段内任意字符、`?` 单段内单字符。
 * 与 Rust 实现的对齐约定：
 * - 模式含 `/` → 对相对路径整体匹配；不含 `/` → 对任意一段的段名匹配；
 * - 本应用是 Windows 桌面端，匹配统一不区分大小写；
 * - `\` 与 `/` 都视作路径分隔符。
 * 🔴 预览仅供人工参考，**强制执行在后端 path.rs**——两处语义如需调整必须同步改。
 */
export function globMatch(pattern: string, path: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
  const p = norm(pattern);
  const t = norm(path);
  const segMatch = (pat: string[], txt: string[]): boolean => {
    const [ph, ...prest] = pat;
    if (ph === undefined) return txt.length === 0;
    if (ph === "**") {
      for (let n = 0; n <= txt.length; n++) {
        if (segMatch(prest, txt.slice(n))) return true;
      }
      return false;
    }
    const [th, ...trest] = txt;
    if (th === undefined) return false;
    return segFnmatch(ph, th) && segMatch(prest, trest);
  };
  if (p.includes("/")) return segMatch(p.split("/"), t.split("/"));
  return t.split("/").some((seg) => segMatch([p], [seg]));
}

/** 单段内 fnmatch：`*` 任意串、`?` 单字符、其余字面量相等（递归回溯，段很短）。 */
function segFnmatch(pattern: string, text: string): boolean {
  if (pattern.length === 0) return text.length === 0;
  const c = pattern[0];
  const rest = pattern.slice(1);
  if (c === "*") {
    for (let n = 0; n <= text.length; n++) {
      if (segFnmatch(rest, text.slice(n))) return true;
    }
    return false;
  }
  if (text.length === 0) return false;
  if (c === "?") return segFnmatch(rest, text.slice(1));
  return text[0] === c && segFnmatch(rest, text.slice(1));
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

/**
 * 浮层「点外面关闭」的公共判定：面板自身里的按下不算外点；**本面板的开关按钮**
 * （`data-cc-toggle="<owner>"`）也不算 —— 不豁免它的话，capture 的 pointerdown
 * 先把面板收掉，随后的 click 再把面板翻开，这个按钮就永远关不掉自己的浮层。
 *
 * `owner` 之外的开关按钮**仍然算外点**（点了别家开关 ⇒ 先收自己，click 去开别家），
 * 与没有这个 bug 之前的行为一致。
 */
export function isOutsideDismiss(
  e: PointerEvent,
  box: HTMLElement | null,
  owner: string,
): boolean {
  if (box?.contains(e.target as Node)) return false;
  const target = e.target;
  return !(target instanceof Element && target.closest(`[data-cc-toggle="${owner}"]`));
}
