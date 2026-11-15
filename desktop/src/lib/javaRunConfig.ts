import { javaRunDeclarations } from "./javaRunTargets";

export interface JavaRunConfig { path: string; mode: "main" | "test"; classes: string; args: string; extraClasspath: string; }
export const emptyJavaRunConfig = (): JavaRunConfig => ({ path: "", mode: "main", classes: "", args: "", extraClasspath: "" });
export function sourceRunTarget(text: string, line: number, method = false, column = 1): string | null {
  const rows = text.split("\n"), row = Math.max(1, Math.min(line, rows.length));
  const start = rows.slice(0, row - 1).join("\n").length + (row > 1 ? 1 : 0);
  const offset = start + Math.max(0, Math.min(column - 1, rows[row - 1].length));
  const declarations = javaRunDeclarations(text);
  const selected = declarations.filter(entry => entry.kind === (method ? "method" : "type") && entry.start <= offset && offset < entry.end).sort((a, b) => b.depth - a.depth)[0];
  if (selected) return method ? `${selected.binaryName}#${selected.name}` : selected.binaryName;
  return method ? null : declarations.find(entry => entry.kind === "type" && entry.depth === 0)?.binaryName ?? null;
}
export const inputLines = (value: string): string[] => value.split(/\r?\n/).filter(line => line.trim().length > 0);
export function failedRunTargets(failures: { className: string; method: string }[]): string[] {
  return [...new Set(failures.map(f => /^[\w$]+$/.test(f.method) ? `${f.className}#${f.method}` : f.className))];
}
