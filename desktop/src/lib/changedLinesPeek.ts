/**
 * 基线浮层：从 gutter 拆出来，独立负责定位、Esc、点击外部关闭、块级动作。
 *
 * 这里刻意不 import monaco / editorStore：浮层只接收已经算好的 anchor 与回调，
 * 这样 BottomPanel 的 jsdom 测试不会被静态链把 monaco-editor 拖进来。
 * 所有文本一律走 textContent，代码里可能有 HTML。
 */
export interface PeekAnchor {
  top: number;
  left: number;
  width: number;
}

export interface PeekOptions {
  anchor: PeekAnchor;
  head: string;
  code: string;
  tip: string;
  reviewed: boolean;
  roundLabel: string | null;
  actions: {
    onMark: () => void;
    onNext: () => void;
    onCopy: () => void;
    onRevert: () => void;
    onSelectRound: (() => void) | null;
  };
}

let closer: (() => void) | null = null;
/** 延后挂外点监听的定时器；关闭时取消，别让监听漏在 document 上。 */
let pendingDocTimer: number | null = null;

/** 重入安全：先把 closer 摘下来再执行清理，Esc 与「关闭」同时触发不会递归。 */
export function closeChangedPeek(): void {
  const fn = closer;
  closer = null;
  fn?.();
}

function button(label: string, kind: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `ncf-peek-btn ncf-peek-${kind}`;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

export function openChangedPeek(o: PeekOptions): void {
  closeChangedPeek();
  const el = document.createElement("div");
  el.className = "ncf-peek";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "基线原内容");

  const head = document.createElement("div");
  head.className = "ncf-peek-hd";
  head.textContent = o.head;
  el.appendChild(head);

  if (o.roundLabel) {
    const round = document.createElement("div");
    round.className = "ncf-peek-round";
    round.textContent = o.roundLabel;
    el.appendChild(round);
  }

  const pre = document.createElement("pre");
  pre.className = "ncf-peek-code";
  pre.textContent = o.code;
  el.appendChild(pre);

  const tip = document.createElement("p");
  tip.className = "ncf-peek-tip";
  tip.textContent = o.tip;
  el.appendChild(tip);

  const actions = document.createElement("div");
  actions.className = "ncf-peek-actions";
  actions.appendChild(button(o.reviewed ? "取消此块已审" : "标记此块已审", "ghost", () => {
    o.actions.onMark();
    closeChangedPeek();
  }));
  actions.appendChild(button("下一处未审", "ghost", () => {
    o.actions.onNext();
    closeChangedPeek();
  }));
  actions.appendChild(button("复制给 Claude", "ghost", o.actions.onCopy));
  if (o.actions.onSelectRound) {
    actions.appendChild(button("选中这一轮", "ghost", () => {
      o.actions.onSelectRound!();
      closeChangedPeek();
    }));
  }
  actions.appendChild(button("还原此块", "primary", o.actions.onRevert));
  actions.appendChild(button("关闭", "ghost", closeChangedPeek));
  el.appendChild(actions);

  el.style.top = `${o.anchor.top}px`;
  el.style.left = `${o.anchor.left}px`;
  el.style.width = `${o.anchor.width}px`;
  document.body.appendChild(el);

  const onDoc = (e: MouseEvent) => {
    if (!el.contains(e.target as Node)) closeChangedPeek();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    closeChangedPeek();
  };
  // 外点关闭延一帧挂：点开浮层的那一次 mousedown 还没结束，立刻挂会把自己关掉。
  // 定时器句柄必须留着：浮层在它触发前就关了（Esc / 下一处 / 重开）时取消掉，
  // 否则迟到的那一次 addEventListener 会把监听永久留在 document 上。
  pendingDocTimer = window.setTimeout(() => {
    pendingDocTimer = null;
    document.addEventListener("mousedown", onDoc, true);
  }, 0);
  document.addEventListener("keydown", onKey, true);

  closer = () => {
    if (pendingDocTimer !== null) {
      window.clearTimeout(pendingDocTimer);
      pendingDocTimer = null;
    }
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
    el.remove();
  };
}

/**
 * 浮层锚点：宽度跟着编辑器走（窄分屏不再固定 360px 压代码），
 * 右上角对齐但绝不越出窗口，纵向留 280px 给浮层自身。
 */
export function peekAnchor(rect: DOMRect | undefined, visibleTop: number | undefined): PeekAnchor {
  const width = Math.min(360, Math.max(240, (rect?.width ?? 360) - 24));
  const top = Math.min(
    Math.max(8, (rect?.top ?? 0) + (visibleTop ?? 0)),
    Math.max(8, window.innerHeight - 280),
  );
  const left = Math.min(
    Math.max(8, (rect?.right ?? window.innerWidth) - width - 12),
    Math.max(8, window.innerWidth - width - 8),
  );
  return { top, left, width };
}
