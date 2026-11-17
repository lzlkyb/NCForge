/**
 * 跨 IPC 类型契约：把「Rust 生成的类型」与「前端手写的类型」钉在一起。
 *
 * 🔴 这个文件里**没有一行运行时代码**，全部是类型断言。它的唯一作用是在
 * `tsc --noEmit` 阶段失败——这就是 P0-2 的验收标准：
 *
 *   改一个 Rust struct 的字段名 → `npm run bindings:generate` → 生成物变
 *   → 这里的 `Equal` / `Assignable` 断言红 → tsc 红。
 *
 * 为什么不直接用生成物替换手写类型：手写类型带着大量「为什么这么设计」的注释
 * （`linked_overrides` 不能走 `patchConfig`、`db_conns` 里是 camelCase 等等），
 * 那些是给人看的资产。生成物负责「不许漂」，手写类型负责「说清楚」，两者用断言对齐。
 *
 * 为什么 `linked_overrides` 单独比：前端用 `OverrideAction` 联合类型（更严格）和
 * 可选 `dir`（构造时可以省略），Rust 侧是 `String` 与必填 `Option<String>`。
 * 这里的规则是「前端可以更严格，不许更宽松」，所以只断言单项可赋值。
 */
import type { AppConfig, ConfigPatch } from "./appConfig";
import type { LinkedOverride } from "./linkedProjects";
import type {
  AppConfig as GenAppConfig,
  ConfigPatch as GenConfigPatch,
  LinkedOverrideConfig as GenLinkedOverride,
} from "./bindings.generated";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assignable<T, U> = T extends U ? true : false;
type Assert<T extends true> = T;

/** 键集合必须完全一致：少声明一个字段（历史上有过 12 个）或凭空多一个都算错。 */
export type AppConfigKeys = Assert<Equal<keyof AppConfig, keyof GenAppConfig>>;
export type ConfigPatchEqual = Assert<Equal<ConfigPatch, GenConfigPatch>>;

/**
 * `linked_overrides` 的条目类型前端更严格（`OverrideAction`），但**字段名与嵌套形状**
 * 必须能塞进 Rust 的类型——否则后端反序列化会静默丢掉这条覆盖。
 *
 * `RequiredOf` 去掉可选修饰再比：`dir?:` 是前端构造时的便利（省略即不改），
 * 不影响它序列化出去的形状。
 */
type RequiredOf<T> = { [K in keyof T]-?: T[K] };
export type LinkedOverrideFits = Assert<Assignable<RequiredOf<LinkedOverride>, GenLinkedOverride>>;

type AppConfigNoLinked = Omit<AppConfig, "linked_overrides">;
type GenAppConfigNoLinked = Omit<GenAppConfig, "linked_overrides">;

/** 逐字段双向兼容：任一侧的类型写宽/写窄到对方接不住，都会红。 */
export type AppConfigToRust = Assert<Assignable<AppConfigNoLinked, GenAppConfigNoLinked>>;
export type RustToAppConfig = Assert<Assignable<GenAppConfigNoLinked, AppConfigNoLinked>>;
