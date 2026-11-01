// 删除确认里那段正文（文件数 / 打开中的标签 / 未保存的修改）。
//
// 抽成纯函数的原因有两个：FileTree 的行数已经贴着门禁上限；而且这段文案的判断
// 值得单测——「说漏了未保存修改」是直接导致丢数据的措辞错误。
export interface DeleteFacts {
  isDir: boolean;
  files: number;
  labels: number;
  unsaved: number;
  /** 别处引用这个类的地方数（只对 .java 有意义）。 */
  refs?: number;
  refSamples?: string[];
}

/**
 * 删除确认的正文：三件事分开说。
 *
 * 最后一条必须单独讲：用户以为删的是磁盘上的旧版本，实际手上那份没落盘的修改
 * 也会随标签关闭一起消失——那往往是唯一副本。
 */
export function deleteDescription(d: DeleteFacts): string | undefined {
  const parts: string[] = [];
  if (d.isDir) {
    // 后端数到 20000 就不再数了，会回 20001 表示「还要多」——
    // 直接显示 20001 会让人以为是个精确值
    parts.push(`共 ${d.files > 20000 ? "20000+" : d.files} 个文件。`);
    if (d.labels > 0) parts.push(`其中 ${d.labels} 个已在标签中打开，删除后标签会一并关闭。`);
  } else if (d.labels > 0) {
    parts.push("这个文件正在标签里打开，删除后标签会一并关闭。");
  }
  if (d.unsaved > 0) parts.push(`${d.unsaved} 个有未保存的修改，删除后会一并丢失。`);
  // 引用提示放在最后：它不阻止删除，只是让人知道「删了别处会编不过」
  if (!d.isDir && (d.refs ?? 0) > 0) {
    const where = d.refSamples?.length ? `（如 ${d.refSamples.slice(0, 2).join("、")}）` : "";
    parts.push(`别处还有 ${d.refs} 处提到这个类${where}，删除后那些地方会编译不过。`);
  }
  return parts.join(" ") || undefined;
}
