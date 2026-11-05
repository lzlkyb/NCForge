/** Markdown code is rendered as text nodes: release notes must never execute markup. */
export function ReleaseText({ text }: { text: string }) {
  return <>{text.split(/(`[^`]+`)/g).map((part, index) => part.startsWith("`") && part.endsWith("`")
    ? <code key={index}>{part.slice(1, -1)}</code> : part)}</>;
}
