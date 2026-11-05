// 应用元信息（关于卡片用）。
// - 仓库地址来自项目 remote；版权主体来自根目录许可证
// - 协议：根目录 LICENSE（MIT）
// - 更新历史：由 scripts/gen-changelog.mjs 在 predev/prebuild 时从根目录 CHANGELOG.md
//   （Keep a Changelog，唯一手写源）自动解析生成 lib/changelog.generated.ts，此处 re-export。
//   分类映射（新增→feat / 变更与优化→improve / 修复→fix / 安全→sec，技术细节单独保留）
//   集中在脚本内，根除手写数组「双份维护、漏写版本」的痛点。

export const APP_INFO = {
  // 面向用户的**显示名**。与 Rust 侧 `src-tauri/src/branding.rs` 的 APP_DISPLAY_NAME
  // 是同一个字符串的两份维护（前端拿不到 Rust 常量，只能各存一份），改这里请同步改那边
  name: "NCForge",
  // 侧栏品牌区标语。
  tagline: "写代码 · 编译 · 启服务",
  author: "NCForge contributors",
  repoUrl: "https://github.com/lzlkyb/NCForge",
  license: "MIT",
  description: "NC65 / NCC 二开的轻量桌面工作台",
} as const;

export type ChangeCategory = "feat" | "improve" | "fix" | "sec";

/**
 * 存储键/localStorage 前缀用的应用短名，由显示名推导（改名自动跟随）。
 * 多个 Tauri 应用可能共用同一 webview origin，key 不带应用前缀会串台。
 */
export const APP_SLUG = APP_INFO.name
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

export const CATEGORY_LABELS: Record<ChangeCategory, string> = {
  feat: "新增",
  improve: "改进",
  fix: "修复",
  sec: "安全",
};

export interface ChangelogItem {
  category: ChangeCategory;
  text: string;
}

export interface ChangelogEntry {
  version: string;
  date: string;
  items: ChangelogItem[];
  summary?: string[];
  /** 工程记录保留全文，主阅读区只显示用户说明。 */
  technical?: { heading: string; text: string }[];
  /** 本期亮点（可选）：CHANGELOG.md 的 `### 亮点` 小节，UI 顶部突出展示。 */
  highlights?: string[];
}

// CHANGELOG 现由脚本从 CHANGELOG.md 自动生成（见 scripts/gen-changelog.mjs），
// 此处仅 re-export，避免手写数组与 CHANGELOG.md 双份维护、漏写版本。
export { CHANGELOG } from "./changelog.generated";
