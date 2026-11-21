import type { ClipboardEvent } from "react";

/** Single-line controls otherwise silently drop line breaks from pasted queries. */
export function pasteSearchText(event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>, query: string, update: (value: string) => void) {
  const text = event.clipboardData.getData("text/plain").replace(/\r\n/g, "\n");
  if (!text.includes("\n")) return;
  event.preventDefault();
  const { selectionStart, selectionEnd } = event.currentTarget;
  update(query.slice(0, selectionStart ?? query.length) + text + query.slice(selectionEnd ?? query.length));
}
