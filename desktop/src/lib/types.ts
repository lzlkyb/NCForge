/**
 * 壳子共享类型。
 *
 * 只放「壳子自身 + 布局件」需要的最小形状；业务类型放各自的模块
 * （承自 cc-bridge 的 lib/types.ts 拆分经验：一个 600+ 行的 types.ts 是烂账起点）。
 *
 * `StaticStatus` 是「应用状态快照」的通用形状——业务把真实字段挂上来，
 * 布局件（Header/SideNav）只认这里声明的可选字段，缺字段时降级渲染。
 */

export interface StaticStatus {
  /** 当前版本（来自 Cargo.toml 真源，后端命令下发）。 */
  version?: string;
  /** 平台标识（如 "windows" / "macos"），用于平台差异文案。 */
  platform?: string;
  /** 核心服务是否在运行。业务没有「服务」概念时可留空。 */
  running?: boolean;
  /** 启动期错误（有则侧栏状态 pill 升红）。 */
  startupError?: string | null;
}
