/**
 * 弹层宽度档位检查（DESIGN.md R2 / 几何单一真源的延伸）。
 *
 * 背景（2026-11-17）：迁移前全站弹窗实测有 16 种宽度，分散在四套体系里 ——
 * 组件用 Tailwind、CSS 类写死 px、少数用 min()、7 处 tsx 内联 `w-[NNNpx]`。
 * 同一个「小弹窗」在不同页面是 360/380/460/512/620，用户看到的不一致。
 *
 * 规则：弹层的宽度只能是 `var(--w-modal-*)`，不再接受写死像素。
 * 为什么不管高度：高度普遍是 `min(NNNpx, calc(100dvh - …))` 的自适应写法，
 * 与窗口高度强相关，没有"档位"语义，硬套只会制造新的假统一。
 */

/**
 * 类名里出现这些词，就认为是**居中弹窗**。
 *
 * 为什么不收 drawer / overlay：它们是「滑出面板」，常写在容器里
 * （`position:absolute` / `flex-shrink:0`），宽度相对容器而非视口，
 * 用 `--w-modal-*` 的 `100vw` 兜底反而是错的语义。
 */
const MODAL_WORD = /dialog|modal/i;

/**
 * 判断某个选择器是否指向弹层外壳本身（而不是它内部的滚动条、按钮、列表项）。
 *
 * 判据：按逗号拆分后，任一部分的**最后一个复合选择器**是含关键词的类选择器。
 * `.update-dialog-actions .ui-button` → 最后一段是 `.ui-button`，不是弹层 → 放过；
 * `.update-dialog-scroll::-webkit-scrollbar` → 有伪元素 → 放过；
 * `.dbx-drawer.sess` / `.vc-dialog-hk` → 命中。
 */
export function isModalShell(selector) {
  return selector.split(",").some((part) => {
    const p = part.trim();
    if (!p || p.includes("::")) return false;
    // :is(...) / :where(...) 里可能还带类名列表
    const unis = p.match(/:(?:is|where)\(([^)]*)\)/);
    if (unis) return MODAL_WORD.test(unis[1]);
    const last = p.split(/\s+/).pop() ?? "";
    if (!last.startsWith(".")) return false;
    return MODAL_WORD.test(last);
  });
}

/** 直接写死：`width: 660px` 或 `width: min(660px, …)`；`max-width` / `min-width` 不算。 */
const HARD_WIDTH = /(?<![\w-])width\s*:\s*(?:min\(\s*)?(\d+(?:\.\d+)?)px/;
const TOKEN_WIDTH = /var\(\s*--w-modal-[\w-]+\s*\)/;

/** tsx 里的内联宽度：`w-[620px]`。 */
const INLINE_PX = /\b(?:max-)?w-\[(\d+(?:\.\d+)?)px\]/;

/**
 * tsx 里的「自写视口兜底」：`w-[min(720px,92vw)]`。
 *
 * 这是弹层最典型的手写形态，也是最容易漏的一种（2026-11-17 实测漏了
 * `ShortcutSheet` 的 720px，因为旧正则只认纯 `w-[NNNpx]`）。
 * 令牌 `--w-modal-*` 里已经带 `min(Npx, calc(100vw - 32px))`，自写兜底必然与档位脱节，
 * 所以这种写法一律判违规，不需要再看上下文。
 */
const INLINE_VIEWPORT = /\bw-\[min\(\s*(\d+(?:\.\d+)?)px\s*,[^\]]*v[wh][^\]]*\)\]/;

/**
 * 扫描 CSS：选择器含 dialog/modal/overlay/drawer/sheet 的规则里，
 * `width` 必须是 `var(--w-modal-*)`。
 *
 * 不用大括号深度判断，改为「本行有 `{` 就把 `{` 前当选择器」——
 * 这样单行规则（`.dbx-dlg { width: 660px; … }`）和 @media 内的规则都能覆盖。
 *
 * @param {{path:string,text:string}[]} files
 */
export function checkCssModalWidth(files) {
  const violations = [];
  for (const file of files) {
    if (!/\.css$/.test(file.path)) continue;
    // design-preview 是独立设计预览入口，不参与产品 UI 的弹层档位。
    if (file.path.includes("design-preview")) continue;
    const text = file.text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    const lines = text.split("\n");
    let selector = "";
    lines.forEach((line, i) => {
      const brace = line.indexOf("{");
      if (brace >= 0) {
        const head = line.slice(0, brace).trim();
        if (head && !head.startsWith("@")) selector = head;
      }
      if (!selector || !isModalShell(selector)) return;
      if (!HARD_WIDTH.test(line) || TOKEN_WIDTH.test(line)) return;
      violations.push({
        path: file.path,
        line: i + 1,
        selector: selector.slice(0, 60),
        value: `${line.match(HARD_WIDTH)?.[1]}px`,
        reason: "弹层宽度必须用 var(--w-modal-xs|sm|md|lg|xl|2xl)，不要写死像素",
      });
    });
  }
  return violations;
}

/**
 * 找出每个 `<Modal>` / `<Dialog>` **开标签**占的行范围。
 *
 * 只认标签本身，不认 children：此前用「往前看两行」当上下文，
 * 会把弹层里前三行的定宽字段（`<input className="w-[260px]">`）误判成弹层宽度。
 * 逐字符跟踪花括号深度，避免属性里的箭头函数 `=>` 把标签提前截断。
 */
export function modalTagRanges(lines) {
  const ranges = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/<(?:Modal|Dialog)\b/.test(lines[i])) continue;
    let depth = 0;
    let end = i;
    let closed = false;
    for (let j = i; j < lines.length && j < i + 20 && !closed; j += 1) {
      for (const ch of lines[j]) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
        else if (ch === ">" && depth === 0) {
          end = j;
          closed = true;
          break;
        }
      }
    }
    ranges.push([i, end]);
  }
  return ranges;
}

/**
 * 扫描 tsx：`<Modal>` / `<Dialog>` 的 className 里不允许 `w-[620px]` 这类写死宽度。
 *
 * @param {{path:string,text:string}[]} files
 */
export function checkJsxModalWidth(files) {
  const violations = [];
  for (const file of files) {
    if (!/\.tsx$/.test(file.path)) continue;
    const text = file.text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    const lines = text.split("\n");
    const ranges = modalTagRanges(lines);
    const inATag = (i) => ranges.some(([a, b]) => i >= a && i <= b);
    lines.forEach((line, i) => {
      // 自写视口兜底：无需上下文，本身就是弹层写法
      const vp = line.match(INLINE_VIEWPORT);
      if (vp) {
        violations.push({
          path: file.path,
          line: i + 1,
          selector: "className",
          value: `w-[min(${vp[1]}px, …vw)]`,
          reason: "视口兜底已内置在 var(--w-modal-*)，改成 w-[var(--w-modal-*)]",
        });
        return;
      }
      const m = line.match(INLINE_PX);
      if (!m) return;
      if (!inATag(i)) return;
      violations.push({
        path: file.path,
        line: i + 1,
        selector: "className",
        value: `${m[1]}px`,
        reason: "弹层的内联宽度改成 w-[var(--w-modal-*)]",
      });
    });
  }
  return violations;
}

/** 合并两路检查。 */
export function checkModalWidth(files) {
  return [...checkCssModalWidth(files), ...checkJsxModalWidth(files)];
}
