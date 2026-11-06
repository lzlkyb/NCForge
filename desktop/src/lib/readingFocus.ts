export function focusReadingTrigger(host: Element | null, tool: "outline" | "history") {
  const region = host?.closest(".wb-reading-layout") ?? document;
  const regular = region.querySelector<HTMLButtonElement>(`[data-popover="${tool}"]`);
  const fallback = region.querySelector<HTMLButtonElement>('[aria-label="更多阅读工具"]');
  (regular && getComputedStyle(regular).display !== "none" ? regular : fallback)?.focus({ preventScroll: true });
}
