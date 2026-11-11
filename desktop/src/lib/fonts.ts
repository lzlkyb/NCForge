/** Keep these stacks identical to fonts.css: canvas and Monaco must measure the displayed face. */
export const UI_FONT_FAMILY = '"Noto Sans SC", "Segoe UI", "Microsoft YaHei UI", sans-serif';
export const CODE_FONT_FAMILY = '"JetBrains Mono", "Noto Sans SC", Consolas, monospace';

export function codeFontFamilyOf(custom: string): string {
  return custom.trim() ? `${custom.trim()}, ${CODE_FONT_FAMILY}` : CODE_FONT_FAMILY;
}

let revision = 0;
let wired = false;
const listeners = new Set<() => void>();

/** Font swaps change cached glyph widths even when the requested CSS family has not changed. */
export function initializeFonts(): void {
  // Test/older hosts without FontFaceSet keep synchronous fallback metrics; no waiting is required.
  if (wired || typeof document === "undefined" || !document.fonts) return;
  wired = true;
  document.fonts.addEventListener("loadingdone", () => {
    revision += 1;
    listeners.forEach(listener => listener());
  });
}

export function getFontRevision(): number { return revision; }

export function subscribeFonts(listener: () => void): () => void {
  initializeFonts();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
