/**
 * 发布说明尾部内嵌机器可读历史的标记。
 * 契约：必须与前端 src/lib/updateNotes.ts 的 HISTORY 正则一致（那边读取时兼容
 * cc-bridge- 历史前缀）。曾经两侧各写各的导致远端历史静默失效、元数据泄漏进
 * 更新弹窗——src/lib/updateNotes.test.ts 有跨侧回归测试锁死这个契约。
 * 故意用应用无关的通用串：应用改名不会拆断协议。
 */
export const HISTORY_MARKER = "app-release-history:";

/** Keep the legacy notes readable; one-line metadata also stays invisible to older clients. */
export function buildUpdateNotes(notes, version, changelog) {
  const releases = [...changelog.matchAll(/^##\s+\[(\d+\.\d+\.\d+)\]\s*-\s*(\S+)[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/gm)]
    .map((match) => ({
      version: match[1], date: match[2],
      body: match[3].replace(/^###\s*(用户摘要|技术细节|实现说明|开发者)\s*\r?\n[\s\S]*?(?=^###\s|$(?![\s\S]))/gm, "").trim(),
    }));
  const parts = (value) => value.split(".").map(Number);
  const compare = (a, b) => {
    const left = parts(a), right = parts(b);
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  };
  if (!releases.some((release) => release.version === version)) return notes;
  const entries = releases.filter((release) => compare(release.version, version) <= 0)
    .sort((a, b) => compare(b.version, a.version)).slice(0, 10);
  // A changelog item may itself contain an HTML comment terminator.
  const metadata = JSON.stringify(entries).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `${notes}\n\n<!-- ${HISTORY_MARKER}${metadata} -->`;
}
