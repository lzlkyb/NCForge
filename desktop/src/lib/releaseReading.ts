/** An explicit topic prefix is authored in release notes, never guessed from keywords. */
export function releaseText(text: string): string {
  return text.replace(/^(数据库|代码与搜索|NC 开发)｜/, "");
}
export function groupReleaseItems(items: { label: string; text: string }[]) {
  const groups: { label: string; items: string[] }[] = [];
  for (const item of items) {
    const topic = /^(数据库|代码与搜索|NC 开发)｜/.exec(item.text)?.[1] ?? item.label;
    let group = groups.find(entry => entry.label === topic);
    if (!group) { group = { label: topic, items: [] }; groups.push(group); }
    group.items.push(item.text);
  }
  return groups;
}
