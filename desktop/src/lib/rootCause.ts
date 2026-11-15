// 报错 → 根因（B4）。
//
// 只做**确定性映射**：错误码、异常类名、编译器消息的固定句式 → 一句「这是什么」+
// 一句「下一步做什么」。认不出就返回 null，保留原文——猜错的根因比没有根因更贵，
// 用户会照着它改错地方。
//
// 不复写已有的表：数据库错误码走 `oraErrorHint`，连接类走 `dbConnectionHint`，
// 这里只补两块空白——编译错误与 NC 运行时异常。
import { oraHint } from "./oraErrorHint";
import { dbConnectionHint } from "./dbConnectionHint";

export interface RootCause {
  /** 这是什么。一句话，出现在错误行下面。 */
  cause: string;
  /** 下一步做什么。可空（有些错误只能解释，不能给动作）。 */
  action?: string;
  kind: "compile" | "ora" | "exception" | "connection";
}

/** 编译错误：ecj 的消息句式是固定的，逐条对句式比猜关键词稳。 */
const COMPILE_RULES: { match: RegExp; cause: string; action?: string }[] = [
  {
    match: /cannot be resolved to a type/i,
    cause: "这个类型在类路径上找不到。",
    action: "先看「工程关联」里本模块依赖的模块是否都关联了；再看那个类是二开还是标准产品——标准类要确认 NC home 里的 jar 版本对得上。",
  },
  {
    match: /cannot be resolved to a variable/i,
    cause: "变量名对不上：没声明、拼错，或者不在这个作用域里。",
    action: "核对大小写；NC 里同名变量常在不同方法里各有一份，别拿另一个方法的。",
  },
  {
    match: /The import .* cannot be resolved/i,
    cause: "import 的这个类不在类路径里。",
    action: "确认它所在模块已关联；如果只在某个 jar 里，检查该 jar 是否在 NC home 的 lib 下。",
  },
  {
    match: /The method (\w+)\(.*\) is undefined for the type/i,
    cause: "这个方法在这个类型上没有匹配的签名。",
    action: "参数类型或个数对不上最常见：NC 的接口方法经常是 `(String pk, String type)` 这种，别漏参数。",
  },
  {
    match: /must implement the inherited abstract method/i,
    cause: "父类/接口新增了抽象方法，这个类还没实现。",
    action: "看父类版本是不是比你的实现新（升级 NC 补丁后常见）。",
  },
  {
    match: /Duplicate method/i,
    cause: "同一个类里有两个同名同参的方法。",
    action: "NC 的 BMF 生成代码和手写代码容易撞：生成出来的方法别手改同名。",
  },
  {
    match: /Type mismatch: cannot convert from/i,
    cause: "赋值两边的类型不兼容。",
    action: "看是不是把 `UFBoolean` / `UFDateTime` 当成 `boolean` / `Date` 用了。",
  },
  {
    match: /Unreachable code/i,
    cause: "这行永远执行不到（前面已经 return / throw）。",
  },
  {
    match: /Syntax error/i,
    cause: "语法错误。",
    action: "先看这一行的括号是否配对——ecj 报的位置常在真正的错误之后。",
  },
  {
    match: /Local variable \w+ is never read|The value of the local variable \w+ is not used/i,
    cause: "声明了但没用到的局部变量。",
  },
];

/** NC 运行时异常：按类名映射。堆栈里的类名比消息稳定。 */
const EXCEPTION_RULES: { match: RegExp; cause: string; action?: string }[] = [
  {
    match: /\bNCLogicException\b/,
    cause: "业务规则校验没通过。这是业务提示，不是程序缺陷。",
    action: "异常 message 就是给用户的提示文案；要改提示就去抛它的那处业务代码。",
  },
  {
    match: /\bBusinessException\b|\bNcBizException\b/,
    cause: "业务层抛出的异常，通常带明确的业务原因。",
  },
  {
    match: /\bNullPointerException\b/,
    cause: "空指针。",
    action: "从堆栈里第一个属于本工程的帧看起——JDK/中间件那几帧只是路过。",
  },
  {
    match: /\bClassNotFoundException\b|\bNoClassDefFoundError\b/,
    cause: "运行时找不到类：编译期在、运行时不在。",
    action: "多半是模块没部署、或补丁里少了那个 jar。编译通过不代表运行时类路径齐全。",
  },
  {
    match: /\bNoSuchMethodError\b|\bNoSuchFieldError\b/,
    cause: "运行时找到的类版本比编译时旧（缺这个方法/字段）。",
    action: "常见于升级后没重新部署标准产品：编译用的 jar 比服务器上的新。",
  },
  {
    match: /\bStackOverflowError\b/,
    cause: "递归没有终止条件，或对象图里成环。",
  },
  {
    match: /\bOutOfMemoryError\b/,
    cause: "内存不足。",
    action: "先分清是堆（Java heap space）还是元空间/直接内存；堆的话先看有没有一次查全表。",
  },
  {
    match: /\bConcurrentModificationException\b/,
    cause: "遍历集合的同时改了它。",
    action: "改成遍历副本，或用 `Iterator.remove()`。",
  },
];

function compile(message: string): RootCause | null {
  for (const rule of COMPILE_RULES) {
    if (rule.match.test(message)) return { cause: rule.cause, action: rule.action, kind: "compile" };
  }
  return null;
}

function exception(message: string): RootCause | null {
  for (const rule of EXCEPTION_RULES) {
    if (rule.match.test(message)) return { cause: rule.cause, action: rule.action, kind: "exception" };
  }
  return null;
}

/**
 * 一段错误文本 → 根因。认不出返回 `null`（调用方显示原文即可）。
 *
 * 顺序是有意的：先认数据库错误（它的 `ORA-` 码最确定），再认编译错误，
 * 最后才看异常类名——`ORA-00904` 出现在一条 NPE 的 message 里时，前者才是根因。
 */
export function explainError(message: string): RootCause | null {
  const text = message.trim();
  if (!text) return null;

  const ora = oraHint(text, "");
  if (ora?.note) return { cause: ora.note, kind: "ora" };

  // 连接类错误有独立文案（还带「去设置」的动作），但它只对「连不上」成立
  if (/ORA-(01017|12514|12505|12541|28000|28001)|connection refused|网络不可达/i.test(text)) {
    const hint = dbConnectionHint(text);
    return { cause: hint.title, action: hint.help, kind: "connection" };
  }

  return compile(text) ?? exception(text);
}
