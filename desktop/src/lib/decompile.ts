// jar 内类的反编译（后端用 CFR 跑）。
//
// 单独一个文件而不是塞进 `lang.ts`：`lang.ts` 已经是「语言服务」那一大坨，
// 反编译只是它的一个下游消费者（`loadJdtSource` 在拿到签名桩时才调）。
import { invoke } from "./tauri";

/** 一次反编译的结果。`jar` 是绝对路径，只用来告诉用户「这个类来自哪」。 */
export interface Decompiled {
  source: string;
  jar: string;
  /** 全限定类名（内部类保留 `$`）。 */
  class: string;
  /** 后端耗时（含 JVM 启动），供状态提示用。 */
  ms: number;
}

/**
 * 把 `jdt://` 指向的 jar 内类还原成 Java 源码。
 *
 * 失败一律 reject（找不到 jar、CFR 组件没下载、超时）。调用方要能降级成 stub，
 * 不能因为反编译失败就让「打开 jar 里的类」整个不可用。
 */
export const decompileClass = (uri: string) => invoke<Decompiled>("decompile_class", { uri });

/** 反编译源码开头的来源标注。
 *
 * 为什么要加在正文里而不是只靠标签上的标记：用户会复制这段代码去搜索、贴给别人、
 * 甚至当参考实现，正文里没有出处就分不清「原始源码」与「还原出来的近似代码」。
 * 只占一行，行号偏移可控（本来跳转目标也只能落在类附近，桩上的行号对不上实现）。
 */
export function decompileHeader(jar: string): string {
  const name = jar.split(/[\\/]/).pop() ?? jar;
  return `// 反编译自 ${name}（CFR）：局部变量名可能丢失，语法糖被展开，与原始源码不逐字一致\n`;
}
