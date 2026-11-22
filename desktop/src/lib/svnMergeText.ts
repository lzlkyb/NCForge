const start = /^<<<<<<<(?:\s|$)/;
const base = /^\|\|\|\|\|\|\|(?:\s|$)/;
const divider = /^=======(?:\s|$)/;
const end = /^>>>>>>>(?:\s|$)/;
const marker = /^(?:<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)(?:\s|$)/;

export type SvnConflictChoice = "mine" | "theirs" | "both";

export function remainingSvnConflictMarkers(text: string): number {
  const lines = text.split("\n");
  return lines.filter(line => start.test(line)).length || (lines.some(line => marker.test(line)) ? 1 : 0);
}

/** Apply one SVN marker block so already merged context and later conflicts remain intact. */
export function acceptSvnConflictBlock(text: string, choice: SvnConflictChoice): string | null {
  const lines = text.split(/(?<=\n)/);
  const first = lines.findIndex(line => start.test(line));
  if (first < 0) return null;
  let ancestor = -1, middle = -1, last = -1;
  for (let index = first + 1; index < lines.length; index++) {
    const line = lines[index];
    if (start.test(line)) return null;
    if (base.test(line) && middle < 0 && ancestor < 0) ancestor = index;
    else if (divider.test(line) && middle < 0) middle = index;
    else if (end.test(line) && middle >= 0) { last = index; break; }
    else if (marker.test(line)) return null;
  }
  if (last < 0) return null;
  const mine = lines.slice(first + 1,ancestor < 0 ? middle : ancestor);
  const theirs = lines.slice(middle + 1,last);
  const chosen = choice === "mine" ? mine : choice === "theirs" ? theirs : [...mine,...theirs];
  return [...lines.slice(0,first),...chosen,...lines.slice(last + 1)].join("");
}
